import { Context, Schema, h } from 'koishi'

export const name = 'minecraft-versions-checker'

export interface Config {
  interval: number
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
  let knownVersions = new Set<string>()
  let isFirstRun = true

  const effectiveConfig = {
    interval: config.interval || 60,
    groups: config.groups || [],
    enableRelease: config.enableRelease !== undefined ? config.enableRelease : true,
    enableSnapshot: config.enableSnapshot !== undefined ? config.enableSnapshot : true,
    enablePreRelease: config.enablePreRelease !== undefined ? config.enablePreRelease : true,
    enableReleaseCandidate: config.enableReleaseCandidate !== undefined ? config.enableReleaseCandidate : true,
    messageTemplate: config.messageTemplate || '【MC更新】发现新的Minecraft{type}：{version}\n文章地址：{url}',
    useProxy: config.useProxy !== undefined ? config.useProxy : false,
    proxyUrl: config.proxyUrl || 'http://127.0.0.1:7890',
  }

  function detectVersionType(versionId: string): string {
    const versionLower = versionId.toLowerCase()
    
    if (versionLower.includes('pre')) return 'pre-release'
    if (versionLower.includes('rc')) return 'release-candidate'
    
    const snapshotPattern = /^\d+w\d+[a-z]$/
    if (snapshotPattern.test(versionLower)) return 'snapshot'
    
    const releasePattern = /^\d+\.\d+(\.\d+)?$/
    if (releasePattern.test(versionLower)) return 'release'
    
    return 'unknown'
  }

  function generateArticleUrl(versionInfo: VersionInfo): string {
    const versionId = versionInfo.id
    const versionType = detectVersionType(versionId)
    
    switch (versionType) {
      case 'release':
        const versionSlug = versionId.replace(/\./g, '-')
        return `https://www.minecraft.net/zh-hans/article/minecraft-java-edition-${versionSlug}`
      
      case 'snapshot':
        return `https://www.minecraft.net/zh-hans/article/minecraft-snapshot-${versionId}`
      
      case 'pre-release':
        if (versionId.includes('-')) {
          const [basePart, prePart] = versionId.split('-', 2)
          const baseSlug = basePart.replace(/\./g, '-')
          const preNum = prePart.includes('.') ? prePart.split('.')[1] : '1'
          return `https://www.minecraft.net/zh-hans/article/minecraft-${baseSlug}-pre-release-${preNum}`
        }
        break
      
      case 'release-candidate':
        if (versionId.includes('-')) {
          const [basePart, rcPart] = versionId.split('-', 2)
          const baseSlug = basePart.replace(/\./g, '-')
          const rcNum = rcPart.includes('.') ? rcPart.split('.')[1] : '1'
          return `https://www.minecraft.net/zh-hans/article/minecraft-${baseSlug}-release-candidate-${rcNum}`
        }
        break
    }
    
    return `未知版本类型: ${versionId}`
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
    try {
      const httpConfig: any = {
        timeout: 10000
      }

      if (effectiveConfig.useProxy && effectiveConfig.proxyUrl) {
        httpConfig.proxy = {
          protocol: 'http',
          host: effectiveConfig.proxyUrl.split('://')[1].split(':')[0],
          port: parseInt(effectiveConfig.proxyUrl.split(':').pop() || '7890')
        }
      }

      const response = await ctx.http.get('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', httpConfig)
      return response
    } catch (error) {
      logger.error('获取版本清单失败:', error)
      throw error
    }
  }

  function generateGroupMessage(versionInfo: VersionInfo): string {
    const versionType = detectVersionType(versionInfo.id)
    const versionTypeName = getVersionTypeName(versionType)
    const articleUrl = generateArticleUrl(versionInfo)
    
    const message = effectiveConfig.messageTemplate
      .replace(/{type}/g, versionTypeName)
      .replace(/{version}/g, versionInfo.id)
      .replace(/{url}/g, articleUrl)
    
    return message
  }

  async function sendGroupMessage(versionInfo: VersionInfo, isTest: boolean = false) {
    const versionType = detectVersionType(versionInfo.id)
    
    if (!isTest) {
      if (
        (versionType === 'release' && !effectiveConfig.enableRelease) ||
        (versionType === 'snapshot' && !effectiveConfig.enableSnapshot) ||
        (versionType === 'pre-release' && !effectiveConfig.enablePreRelease) ||
        (versionType === 'release-candidate' && !effectiveConfig.enableReleaseCandidate)
      ) {
        return
      }
    }
    
    const message = generateGroupMessage(versionInfo)
      for (const groupId of effectiveConfig.groups) {
        try {
          await ctx.broadcast([groupId], message)
         
        } catch (error) {
          logger.error(`向群 ${groupId} 发送消息失败:`, error)
        }
      }
  }

  
  async function checkForUpdates() {
    try {
      const manifest = await fetchVersionManifest()
      
      if (isFirstRun) {
        for (const version of manifest.versions) {
          knownVersions.add(version.id)
        }
        isFirstRun = false
        return
      }
      
      const newVersions: VersionInfo[] = []
      for (const version of manifest.versions) {
        if (!knownVersions.has(version.id)) {
          newVersions.push(version)
          knownVersions.add(version.id)
        }
      }
      
      if (newVersions.length > 0) {
        newVersions.sort((a, b) => new Date(b.releaseTime).getTime() - new Date(a.releaseTime).getTime())
        
        for (const version of newVersions) {
          await sendGroupMessage(version)
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      } else {
        logger.debug('未发现新版本')
      }
      
    } catch (error) {
      logger.error('检查更新失败:', error)
    }
  }

  ctx.command('mc-check', '手动检查Minecraft版本更新')
    .action(async ({ session }) => {
      try {
        const manifest = await fetchVersionManifest()
        
        const latestRelease = manifest.versions.find(v => v.id === manifest.latest.release)
        const latestSnapshot = manifest.versions.find(v => v.id === manifest.latest.snapshot)
        
        let message = '当前最新版本：\n'
        if (latestRelease) {
          const releaseUrl = generateArticleUrl(latestRelease)
          message += `正式版: ${latestRelease.id}\n文章地址: ${releaseUrl}\n`
        }
        if (latestSnapshot) {
          const snapshotUrl = generateArticleUrl(latestSnapshot)
          message += `快照版: ${latestSnapshot.id}\n文章地址: ${snapshotUrl}`
        }
        
        await session.send(message)
      } catch (error) {
        await session.send('检查失败，请稍后重试')
      }
    })

  ctx.command('mc-status', '查看Minecraft版本检查器状态')
    .action(async ({ session }) => {
      const status = {
        '检查间隔': `${effectiveConfig.interval} 秒`,
        '监控群组': effectiveConfig.groups.length > 0 ? effectiveConfig.groups.join(', ') : '无',
        '已知版本数': knownVersions.size,
        '通知类型': [
          effectiveConfig.enableRelease && '正式版',
          effectiveConfig.enableSnapshot && '快照',
          effectiveConfig.enablePreRelease && '预发布版',
          effectiveConfig.enableReleaseCandidate && '发布候选'
        ].filter(Boolean).join(', '),
        '消息模板': effectiveConfig.messageTemplate,
        '使用代理': effectiveConfig.useProxy ? '是' : '否',
        '代理地址': effectiveConfig.useProxy ? effectiveConfig.proxyUrl : '未使用'
      }
      
      let message = 'Minecraft版本检查器状态：\n'
      for (const [key, value] of Object.entries(status)) {
        message += `${key}: ${value}\n`
      }
      
      await session.send(message)
    })

 
  
  const timer = setInterval(checkForUpdates, effectiveConfig.interval * 1000)
  
  ctx.on('dispose', () => {
    clearInterval(timer)
  })

  checkForUpdates().catch(error => {
    logger.error('初始检查失败:', error)
  })
}