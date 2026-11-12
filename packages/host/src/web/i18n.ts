import { createInstance } from './vendor/i18next.js'
import type { HostLocale } from './locale.js'

// Source copy belongs to the shell. Application names and descriptions are application data.
const zh = {
  menu: 'Anybox 应用菜单', menuCurrent: 'Anybox 应用菜单 · {{name}}', menuHelp: '点击展开菜单，拖动调整位置',
  applications: '应用', switchApplication: '切换应用', currentActions: '当前应用操作', manage: '管理应用', manager: '应用管理',
  closeManager: '关闭应用管理', installed: '已安装应用', closeCurrent: '关闭当前界面', closeCurrentTitle: '关闭当前应用界面',
  stopCurrent: '停止当前应用', stop: '停止应用', close: '关闭界面', open: '打开应用', enter: '进入应用', retry: '重试启动', reload: '重新加载界面',
  openNamed: '打开 {{name}}', stopNamed: '停止 {{name}}', closeNamed: '关闭 {{name}} 界面', detailsNamed: '{{name}} 的详情与操作',
  language: '语言', system: '跟随系统', disabled: '尚未打开', applying: '正在处理', running: '运行中', blocked: '依赖未就绪', failed: '启动或关闭失败',
  available: '可打开', unknown: '暂时无法确认状态', controlling: '正在处理应用操作…',
  ready: '已就绪', missing: '未提供', unsupported: '当前平台不支持', incompatible: '版本不兼容', conflict: '与正在使用的提供方冲突', capabilityFailed: '初始化或清理失败',
  directoryPicker: '系统目录选择', storage: '本地存储', capability: '{{name}}：{{status}}', required: '应用所需功能尚未就绪',
  optionalNamed: '{{name}}暂不可用', optional: '{{count}} 项可选功能暂不可用', loading: '正在加载应用界面…',
  empty: '还没有应用，安装一个应用开始使用。', catalogUnavailable: '暂时无法读取应用目录。',
  hostUnavailable: '无法连接应用宿主，请确认客户端仍在运行。', pageExitUnknown: '页面退出尚未确认，请重启宿主后刷新页面。',
  cleanupFailed: '应用界面清理失败，请重新启动 Anybox 后恢复。', interfaceFailed: '应用界面暂时无法加载，请重新加载界面。', switchFailed: '应用界面暂时无法切换。',
  unavailable: '此应用暂不可用。', saveFirst: '请先完成或保存当前应用中的编辑。', applicationCleanupFailed: '应用清理失败，需要重启宿主。',
  awaitingDependencies: '应用正在等待依赖。', startupFailed: '应用启动失败，可重试启动。', reconciling: '应用操作未完成，正在核对当前状态。',
  stopFailed: '应用停止失败，请检查状态后重试。', busy: '应用仍有任务或写入进行中，请稍后停止。',
  stopStorageFailed: '无法保存停止状态，应用尚未停止，请稍后重试。', stopRetry: '应用尚未停止，请重试；若持续失败，请检查宿主日志。',
  stopUnknown: '停止结果尚未确认，正在核对当前状态。', awaitingStop: '正在等待应用停止完成。', addressFailed: '无法打开该应用地址。', restoreFailed: '应用工作区暂时无法恢复。',
} as const
export type HostMessageKey = keyof typeof zh
const en = {
  menu: 'Anybox app menu', menuCurrent: 'Anybox app menu · {{name}}', menuHelp: 'Click to open the menu. Drag to move it.',
  applications: 'Apps', switchApplication: 'Switch apps', currentActions: 'Current app actions', manage: 'Manage apps', manager: 'App management',
  closeManager: 'Close app management', installed: 'Installed apps', closeCurrent: 'Close current view', closeCurrentTitle: 'Close current app view',
  stopCurrent: 'Stop current app', stop: 'Stop app', close: 'Close view', open: 'Open app', enter: 'Go to app', retry: 'Retry startup', reload: 'Reload view',
  openNamed: 'Open {{name}}', stopNamed: 'Stop {{name}}', closeNamed: 'Close {{name}} view', detailsNamed: 'Details and actions for {{name}}',
  language: 'Language', system: 'Follow system', disabled: 'Not open', applying: 'Processing', running: 'Running', blocked: 'Dependencies not ready', failed: 'Startup or shutdown failed',
  available: 'Available', unknown: 'Status unavailable', controlling: 'Processing app operation…',
  ready: 'Ready', missing: 'Not provided', unsupported: 'Unsupported on this platform', incompatible: 'Incompatible version', conflict: 'Conflicts with an active provider', capabilityFailed: 'Initialization or cleanup failed',
  directoryPicker: 'System folder picker', storage: 'Local storage', capability: '{{name}}: {{status}}', required: 'Required app capabilities are not ready',
  optionalNamed: '{{name}} unavailable', optional: '{{count}} optional capabilities unavailable', optional_one: '{{count}} optional capability unavailable', optional_other: '{{count}} optional capabilities unavailable', loading: 'Loading app view…',
  empty: 'No apps installed yet. Install an app to get started.', catalogUnavailable: 'The app catalog is unavailable.',
  hostUnavailable: 'Cannot connect to the app host. Check that the client is still running.', pageExitUnknown: 'Page exit is unconfirmed. Restart the host before refreshing.',
  cleanupFailed: 'App view cleanup failed. Restart Anybox to recover.', interfaceFailed: 'The app view could not load. Reload the view.', switchFailed: 'Unable to switch app views.',
  unavailable: 'This app is unavailable.', saveFirst: 'Finish or save your edits in the current app first.', applicationCleanupFailed: 'App cleanup failed. Restart the host.',
  awaitingDependencies: 'The app is waiting for dependencies.', startupFailed: 'App startup failed. You can retry.', reconciling: 'The app operation did not finish. Checking its current state.',
  stopFailed: 'The app did not stop. Check its state before retrying.', busy: 'The app still has running tasks or writes. Try stopping it later.',
  stopStorageFailed: 'The stop state could not be saved. The app has not stopped. Try again later.', stopRetry: 'The app has not stopped. Retry, and check the host logs if it keeps failing.',
  stopUnknown: 'The stop result is unconfirmed. Checking its current state.', awaitingStop: 'Waiting for the app to stop.', addressFailed: 'Unable to open this app address.', restoreFailed: 'Unable to restore the app workspace.',
} satisfies Record<HostMessageKey, string> & Record<string, string>

type Variables<S extends string> = S extends `${string}{{${infer Name}}}${infer Rest}` ? Name | Variables<Rest> : never
export type HostPlainMessageKey = { [Key in HostMessageKey]: Variables<(typeof zh)[Key]> extends never ? Key : never }[HostMessageKey]
type Arguments<K extends HostMessageKey> = [Variables<(typeof zh)[K]>] extends [never] ? []
  : [values: { [Name in Variables<(typeof zh)[K]>]: Name extends 'count' ? number : string }]

/** Local, text-only translator. Every use is a DOM text/attribute setter, never HTML. */
export function createHostI18n(locale: () => HostLocale) {
  const engine = createInstance()
  void engine.init({ initAsync: false, lng: 'zh-CN', fallbackLng: 'zh-CN', supportedLngs: ['zh-CN', 'en'], load: 'currentOnly',
    resources: { 'zh-CN': { translation: zh }, en: { translation: en } }, returnNull: false, returnEmptyString: false,
    interpolation: { escapeValue: false } })
  return <K extends HostMessageKey>(key: K, ...args: Arguments<K>): string => engine.t(key, { ...args[0], lng: locale(), defaultValue: zh[key] })
}
