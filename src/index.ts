import { Context, Schema, h } from 'koishi'

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
    .default('【MC更新】发现新的Minecraft{type}：{version}\n文章地址：{url}')
    .description('消息模板，可用变量：{type}版本类型, {version}版本号, {url}文章地址'),
  useProxy: Schema.boolean().default(false).description('是否使用代理'),
  proxyUrl: Schema.string().default('http://127.0.0.1:7890').description('代理地址'),
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
    const id = versionInfo.id
    const type = detectVersionType(id)

    if (type === 'release') {
      const slug = id.replace(/\./g, '-')
      return `https://www.minecraft.net/en-us/article/minecraft-java-edition-${slug}`
    }

    const match = id.match(/^([\d\.]+)-([a-z]+)-(\d+)$/)
    if (match) {
      const baseVersion = match[1].replace(/\./g, '-')
      const kind = match[2]
      const number = match[3]

      let articleKind = kind === 'pre' ? 'pre-release' : kind === 'rc' ? 'release-candidate' : kind
      return `https://www.minecraft.net/en-us/article/minecraft-${baseVersion}-${articleKind}-${number}`
    }

    if (/^\d{2}w\d+[a-z]$/.test(id)) {
      return `https://www.minecraft.net/en-us/article/minecraft-snapshot-${id}`
    }

    return `https://www.minecraft.net/en-us/article/minecraft-java-edition-${id.replace(/\./g, '-')}`
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

  async function fetchVersionManifest(): Promise<VersionManifest> {
    const httpConfig: any = { timeout: 10000 }
    if (config.useProxy && config.proxyUrl) {
      const url = new URL(config.proxyUrl)
      httpConfig.proxy = {
        protocol: url.protocol.replace(':', ''),
        host: url.hostname,
        port: parseInt(url.port)
      }
    }
    return await ctx.http.get('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', httpConfig)
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
      try {
        await task()
      } finally {
        runningTasks--
        dispatch()
      }
    }
  }

  async function performCheck() {
    try {
      const manifest = await fetchVersionManifest()
      
      if (isFirstRun) {
        manifest.versions.forEach(v => knownVersions.add(v.id))
        isFirstRun = false
        logger.info('Minecraft 版本检查初始化完成')
        return
      }

      const newVersions = manifest.versions.filter(v => !knownVersions.has(v.id))
      
      if (newVersions.length > 0) {
        newVersions.forEach(v => knownVersions.add(v.id))
        
        newVersions.sort((a, b) => new Date(b.releaseTime).getTime() - new Date(a.releaseTime).getTime())
        for (const version of newVersions) {
          await sendGroupMessage(version)
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    } catch (error) {
      logger.error('检查更新失败:', error.message)
    }
  }

  ctx.command('mc-check', '手动检查Minecraft版本更新')
    .action(async ({ session }) => {
      try {
        const manifest = await fetchVersionManifest()
        const latestRel = manifest.versions.find(v => v.id === manifest.latest.release)
        const latestSnp = manifest.versions.find(v => v.id === manifest.latest.snapshot)
        
        return `当前最新版本：\n正式版: ${latestRel?.id || '未知'}\n文章: ${generateArticleUrl(latestRel)}\n\n快照版: ${latestSnp?.id || '未知'}\n文章: ${generateArticleUrl(latestSnp)}`
      } catch (e) {
        return '检查失败，请检查网络或代理设置'
      }
    })

  ctx.command('mc-status', '查看版本检查器状态', { authority: 3 })
    .action(() => {
      return [
        `并发状态: ${runningTasks}/${config.maxConcurrency}`,
        `排队任务: ${taskQueue.length}`,
        `已知版本: ${knownVersions.size}`,
        `检查频率: ${config.interval}s`,
        `代理状态: ${config.useProxy ? '已开启' : '关闭'}`
      ].join('\n')
    })

  const timer = setInterval(() => {
    taskQueue.push(performCheck)
    dispatch()
  }, config.interval * 1000)

  ctx.on('dispose', () => {
    clearInterval(timer)
    taskQueue.length = 0
  })

  taskQueue.push(performCheck)
  dispatch()
}