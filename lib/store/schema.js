/**
 * 极小的结构校验器：只实现 `ctx.storageDomain` 实际会调用的那部分表面。
 *
 * ## 为什么不用 zod
 *
 * 官方 `DomainSpec` 的 `valueSchema` / `global.schema` 声明类型是 `ZodType`
 * （`@deepseek-ai/dsh-storage-domain/lib/types/spec.d.ts`），因此"官方 API 要求
 * zod 类型"这句话本身是对的。但把它作为一个**可安装依赖**引入本插件在当前环境
 * 下不成立，原因已实测：
 *
 *   1. 插件以 `link:` 方式装进 profile 后，`dsh plugin add` **不会**为被链接的包
 *      安装它自己的 dependencies（pnpm 对 `link:` 协议不处理目标包的依赖），因此
 *      `package.json` 里声明 `zod` 不会让 `import 'zod'` 在插件目录内可解析。
 *   2. 从插件真实路径（profile 的 `node_modules/<插件名>`）向上解析，只能命中
 *      profile 顶层 node_modules。本机该处的 zod 是 **4.1.8**，既不满足
 *      `dsh-storage-domain` 声明的 `^4.4.3`，也是 `billion-context` 依赖被提升上来的
 *      偶然产物 —— 正是用户明确禁止依赖的那种幻影包。
 *   3. `@deepseek-ai/dsh-storage-domain` 自身也**不可从 profile 解析**
 *      （`ERR_MODULE_NOT_FOUND`），所以连"用官方 helper 造 spec"都做不到。
 *
 * ## 因此本模块的做法
 *
 * 直接提供与 facility 调用点逐条对应的校验器。已核验 facility 只会用到两处
 * （`@deepseek-ai/dsh-storage-domain/lib/index.js`）：
 *
 *   - `:74`   `spec.global.schema.safeParse(null).success`  —— global 不得接受 null
 *   - `:371`  `tableSpec.valueSchema.parse(raw)`            —— 读每条已存记录时校验
 *   - `:383`  `globalSpec.schema.parse(snapshot.global)`    —— 读 global 时校验
 *
 * 全文件没有 `instanceof`，所以凡是具备 `parse` / `safeParse` 的对象都被接受。
 * `src/host/store/index.js` 仍会在启动时**优先尝试**使用官方 `defineDomain` /
 * `domainTable`（见该模块的 `loadSpecBuilders`），只有在不可解析时才退回
 * 本模块 —— 也就是说这里是一条有明确记录的降级路径，而不是对内部实现的假设。
 *
 * 契约（与 zod 对齐）：
 *   - `parse(value)`     失败时 **抛错**，错误的 `issues` 数组说明原因
 *   - `safeParse(value)` 永不抛错，返回 `{success:true,data}` 或 `{success:false,error}`
 *   - 对象校验**丢弃未声明的键**（与 zod 默认行为一致），保证往返稳定
 *
 * @module dsh-apradar/src/host/store/schema
 */

/** 校验失败时抛出的错误。`issues` 与 zod 的 `ZodError.issues` 形状对齐。 */
export class SchemaError extends Error {
  /**
   * @param {string} message 人类可读的失败原因
   * @param {Array<{path: string, message: string}>} issues 逐字段问题
   */
  constructor(message, issues) {
    super(message)
    this.name = 'SchemaError'
    this.issues = issues
  }
}

/**
 * 一个校验器节点。
 * @typedef {object} Validator
 * @property {(value: unknown) => unknown} parse 失败抛错
 * @property {(value: unknown) => {success: true, data: unknown} | {success: false, error: SchemaError}} safeParse
 */

/**
 * 把「返回错误串或 null」的判定函数包装成 Validator。
 * @param {string} label 出错时用于描述这个位置
 * @param {(value: unknown) => string | null} check 返回 `null` 表示通过
 * @param {(value: unknown) => unknown} [coerce] 通过后如何构造结果
 * @returns {Validator}
 */
function make(label, check, coerce) {
  const fail = (detail) => new SchemaError(`${label}: ${detail}`, [{ path: label, message: detail }])

  const parse = (value) => {
    const detail = check(value)
    if (detail !== null) throw fail(detail)
    return coerce ? coerce(value) : value
  }

  return {
    parse,
    safeParse(value) {
      const detail = check(value)
      if (detail !== null) return { success: false, error: fail(detail) }
      return { success: true, data: coerce ? coerce(value) : value }
    },
  }
}

const typeName = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

/** @returns {Validator} 字符串 */
export function string() {
  return make('string', (v) => (typeof v === 'string' ? null : `expected string, got ${typeName(v)}`))
}

/** @returns {Validator} 有限数字（拒绝 NaN / Infinity，因为它们无法 JSON 往返） */
export function number() {
  return make('number', (v) => (typeof v === 'number' && Number.isFinite(v) ? null : `expected finite number, got ${typeName(v)}`))
}

/** @returns {Validator} 非负整数 */
export function count() {
  return make('count', (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? null : `expected non-negative integer, got ${typeName(v)}`))
}

/** @returns {Validator} 布尔 */
export function boolean() {
  return make('boolean', (v) => (typeof v === 'boolean' ? null : `expected boolean, got ${typeName(v)}`))
}

/**
 * 字面量。
 * @param {string | number | boolean} expected 唯一允许的值
 * @returns {Validator}
 */
export function literal(expected) {
  return make(`literal(${JSON.stringify(expected)})`, (v) =>
    v === expected ? null : `expected ${JSON.stringify(expected)}, got ${typeName(v)}`,
  )
}

/**
 * 字符串枚举。
 * @param {readonly string[]} allowed 允许的取值
 * @returns {Validator}
 */
export function enumerate(allowed) {
  return make(`enum(${allowed.join('|')})`, (v) =>
    typeof v === 'string' && allowed.includes(v) ? null : `expected one of ${allowed.join('|')}, got ${typeName(v)}`,
  )
}

/**
 * 数组。
 * @param {Validator} item 元素校验器
 * @returns {Validator}
 */
export function array(item) {
  return make(
    'array',
    (v) => {
      if (!Array.isArray(v)) return `expected array, got ${typeName(v)}`
      for (let index = 0; index < v.length; index += 1) {
        const detail = item.safeParse(v[index])
        if (!detail.success) return `item ${index} invalid: ${detail.error.message}`
      }
      return null
    },
    (v) => v.map((entry) => item.parse(entry)),
  )
}

/**
 * 对象；**丢弃未声明的键**，与 zod 默认行为一致。
 * @param {Record<string, Validator>} shape 字段校验器
 * @returns {Validator}
 */
export function object(shape) {
  const keys = Object.keys(shape)
  const label = `object{${keys.join(',')}}`

  const check = (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return `expected object, got ${typeName(v)}`
    for (const key of keys) {
      const result = shape[key].safeParse(v[key])
      if (!result.success) return `field '${key}' invalid: ${result.error.message}`
    }
    return null
  }

  return make(label, check, (v) => {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of keys) out[key] = shape[key].parse(v[key])
    return out
  })
}

/**
 * 「松散对象」：接受任意普通对象并**原样保留全部键**。
 *
 * 需要它是因为 `sources.config` 的形状由适配器决定（`{owner,repo}` 或 `{feedUrl}`），
 * 存储层无法、也不应该知道每个适配器的字段 —— 但 `object()` 会丢弃未声明的键，
 * 那等于静默损坏用户配置。所以这里只检查「是普通对象、键数与体积在合理范围内」，
 * 语义正确性交给适配器的 `normalizeConfig()`。
 *
 * @param {{maxKeys?: number, maxBytes?: number}} [options] 上界
 * @returns {Validator}
 */
export function looseObject(options = {}) {
  const maxKeys = options.maxKeys ?? 32
  const maxBytes = options.maxBytes ?? 4096
  return make(
    'looseObject',
    (v) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return `expected plain object, got ${typeName(v)}`
      }
      const keys = Object.keys(v)
      if (keys.length > maxKeys) return `too many keys (${keys.length} > ${maxKeys})`
      let serialized
      try {
        serialized = JSON.stringify(v)
      } catch {
        return 'not JSON-serialisable (circular?)'
      }
      if (typeof serialized !== 'string') return 'not JSON-serialisable'
      // 用 JSON 长度近似体积上界，防止有人把整页 HTML 塞进 config。
      if (serialized.length > maxBytes) return `too large (${serialized.length} > ${maxBytes} bytes)`
      return null
    },
    (v) => ({ .../** @type {object} */ (v) }),
  )
}

/**
 * 允许 `undefined`（字段缺失）。**不允许 `null`** —— 与仓库内其他 schema 的约定一致。
 * @param {Validator} inner 内部校验器
 * @returns {Validator}
 */
export function optional(inner) {
  return make(
    'optional',
    (v) => {
      if (v === undefined) return null
      const result = inner.safeParse(v)
      return result.success ? null : result.error.message
    },
    (v) => (v === undefined ? undefined : inner.parse(v)),
  )
}

/**
 * 缺失时补默认值。仅适用于 `undefined`；`null` 仍会被内部校验器拒绝。
 * @param {Validator} inner 内部校验器
 * @param {unknown} fallback 默认值
 * @returns {Validator}
 */
export function withDefault(inner, fallback) {
  return make(
    'default',
    (v) => {
      if (v === undefined) return null
      const result = inner.safeParse(v)
      return result.success ? null : result.error.message
    },
    (v) => (v === undefined ? structuredClone(fallback) : inner.parse(v)),
  )
}
