import { Context, Schema } from 'koishi'
import axios from 'axios'
import { Readable } from 'stream'

export const name = 'minecraft-versions-checker'
export const inject = ['database']

export interface Config {
  interval: number
  maxConcurrency: number
  broadcast: boolean
  groups: string[]
  enableRelease: boolean
  enableSnapshot: boolean
  enablePreRelease: boolean
  enableReleaseCandidate: boolean
  messageTemplate: string
  useProxy: boolean
  proxyUrl: string
  enableTruncate: boolean
}

export const Config: Schema<Config> = Schema.object({
  interval: Schema.number().default(60).description('检查间隔（秒）'),
  maxConcurrency: Schema.number().default(10).description('最大并发请求任务数'),
  broadcast: Schema.boolean().default(true).description('是否广播到所有群聊，打开后忽略群列表'),
  groups: Schema.array(String).role('table').description('要发送通知的群列表'),
  enableRelease: Schema.boolean().default(true).description('启用正式版通知'),
  enableSnapshot: Schema.boolean().default(true).description('启用快照版通知'),
  enablePreRelease: Schema.boolean().default(true).description('启用预发布版通知'),
  enableReleaseCandidate: Schema.boolean().default(true).description('启用发布候选通知'),
  messageTemplate: Schema.string()
    .default('【MC更新】发现新的Minecraft {type}：{version}\n文章地址：{url}')
    .description('消息模板，可用变量：{type}版本类型, {version}版本号, {url}文章地址'),
  useProxy: Schema.boolean().default(false).description('是否使用代理'),
  proxyUrl: Schema.string().default('http://127.0.0.1:7890').description('代理地址'),
  enableTruncate: Schema.boolean().default(true).description('启用流式截断（大幅节省流量，仅拉取最新的4个版本）'),
})

interface VersionInfo {
  id: string
  type: string
  url: string
  time: string
  releaseTime: string
  sha1: string
  complianceLevel: number
}

interface VersionManifest {
  latest: {
    release: string
    snapshot: string
  }
  versions: VersionInfo[]
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('minecraft-versions-checker')
  const knownVersions = new Set<string>()
  let isFirstRun = true
  let runningTasks = 0
  const taskQueue: (() => Promise<void>)[] = []

  function detectVersionType(versionId: string): string {
    const v = versionId.toLowerCase()
    if (/snapshot/.test(v) || /^\d{2}w\d+[a-z]$/.test(v)) return 'snapshot'
    if (/^[\d\.]+-pre-\d+$/.test(v)) return 'pre-release'
    if (/^[\d\.]+-rc-\d+$/.test(v)) return 'release-candidate'
    if (/^\d+(\.\d+){1,2}$/.test(v)) return 'release'
    return 'unknown'
  }

  function generateArticleUrl(versionInfo: VersionInfo): string {
    if (!versionInfo) return 'N/A'
    const id = versionInfo.id
    const type = detectVersionType(id)
    if (type === 'release') {
      return `https://www.minecraft.net/en-us/article/minecraft-java-edition-${id.replace(/\./g, '-')}`
    }
    return `https://www.minecraft.net/en-us/article/minecraft-snapshot-${id}`
  }

  function getVersionTypeName(versionType: string): string {
    const typeMap = {
      'release': '正式版',
      'snapshot': '快照',
      'pre-release': '预发布版',
      'release-candidate': '发布候选'
    }
    return typeMap[versionType] || versionType
  }

  async function fetchVersionManifest(forceFull = false): Promise<VersionManifest> {
    const useTruncate = config.enableTruncate && !forceFull
  
    if (!useTruncate) {
      const { data } = await axios.get(
        'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
        { timeout: 10000 }
      )
      return data
    }
  
    const response = await axios.get(
      'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
      {
        responseType: 'stream',
        timeout: 10000,
        proxy: config.useProxy ? {
          protocol: new URL(config.proxyUrl).protocol.replace(':', ''),
          host: new URL(config.proxyUrl).hostname,
          port: parseInt(new URL(config.proxyUrl).port)
        } : undefined
      }
    )
  
    const stream: Readable = response.data
  
    let buffer = ''
  
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) => {
        buffer += chunk.toString()
  
        const latestMatch = buffer.match(
          /"latest"\s*:\s*\{"release":"([^"]+)","snapshot":"([^"]+)"\}/
        )
  
        const versionBlocks = buffer.match(
          /\{"id":"[^"]+","type":"[^"]+","url":"[^"]+","time":"[^"]+","releaseTime":"[^"]+","sha1":"[^"]+","complianceLevel":\d+\}/g
        )
  
        if (latestMatch && versionBlocks && versionBlocks.length >= 4) {
          try {
            const latest = {
              release: latestMatch[1],
              snapshot: latestMatch[2],
            }
  
            const versions = versionBlocks.map(v => JSON.parse(v))
  
            stream.destroy()
            resolve({ latest, versions } as VersionManifest)
          } catch {
          }
        }
      })
  
      stream.on('end', () => {
        try {
          resolve(JSON.parse(buffer))
        } catch {
          reject(new Error('流结束但解析失败'))
        }
      })
  
      stream.on('error', reject)
    })
  }

  async function sendGroupMessage(versionInfo: VersionInfo) {
    const versionType = detectVersionType(versionInfo.id)
    const isEnabled = 
      (versionType === 'release' && config.enableRelease) ||
      (versionType === 'snapshot' && config.enableSnapshot) ||
      (versionType === 'pre-release' && config.enablePreRelease) ||
      (versionType === 'release-candidate' && config.enableReleaseCandidate)

    if (!isEnabled) return

    const message = config.messageTemplate
      .replace(/{type}/g, getVersionTypeName(versionType))
      .replace(/{version}/g, versionInfo.id)
      .replace(/{url}/g, generateArticleUrl(versionInfo))

    if (!config.broadcast) {
      for (const groupId of config.groups) {
        await ctx.broadcast([groupId], message).catch(e => logger.error(`发送失败: ${groupId}`, e))
      }
    } else {
      await ctx.broadcast(message).catch(e => logger.error(`广播失败`, e))
    }
  }

  async function dispatch() {
    if (runningTasks >= (config.maxConcurrency || 10) || taskQueue.length === 0) return
    const task = taskQueue.shift()
    if (task) {
      runningTasks++
      try { await task() } finally {
        runningTasks--
        dispatch()
      }
    }
  }

  async function performCheck() {
    try {
      const manifest = await fetchVersionManifest(isFirstRun)
      
      if (isFirstRun) {
        manifest.versions.forEach(v => knownVersions.add(v.id))
        isFirstRun = false
        logger.info(`初始化完成，已记录 ${knownVersions.size} 个版本`)
        return
      }

      const newVersions = manifest.versions.filter(v => !knownVersions.has(v.id))
      if (newVersions.length > 0) {
        newVersions.forEach(v => knownVersions.add(v.id))
        newVersions.sort((a, b) => new Date(b.releaseTime).getTime() - new Date(a.releaseTime).getTime())
        for (const version of newVersions) {
          await sendGroupMessage(version)
        }
      }
    } catch (error) {
      logger.error('检查更新失败:', error.message)
    }
  }

  ctx.command('mc-check', '手动检查Minecraft版本更新')
  .action(async () => {
    try {
      const manifest = await fetchVersionManifest()

      const latestRel = manifest.versions.find(v => v.id === manifest.latest.release)
      const latestSnp = manifest.versions.find(v => v.id === manifest.latest.snapshot)

      const relText = latestRel
        ? `正式版: ${latestRel.id}\n${generateArticleUrl(latestRel)}`
        : '正式版: 未知'

      const snpText = latestSnp
        ? `快照版: ${latestSnp.id}\n${generateArticleUrl(latestSnp)}`
        : '快照版: 未知'

      return `当前最新版本：\n\n${relText}\n\n${snpText}`
    } catch (e) {
      return '手动检查失败：' + e.message
    }
  })

  ctx.command('mc-status', '查看插件状态', { authority: 3 })
    .action(() => {
      return [
        `运行状态: ${runningTasks}/${config.maxConcurrency}`,
        `已知版本: ${knownVersions.size}`,
        `流式模式: ${config.enableTruncate ? '开启' : '关闭'}`
      ].join('\n')
    })

  const timer = setInterval(() => {
    taskQueue.push(performCheck)
    dispatch()
  }, config.interval * 1000)

  ctx.on('dispose', () => {
    clearInterval(timer)
  })
  
  taskQueue.push(performCheck)
  dispatch()
}