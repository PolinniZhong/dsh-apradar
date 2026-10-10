/**
 * 运行时能力探测的契约测试（P1-06 / V4）。
 *
 * 这些断言守的是两件事，都不是"格式好看"：
 *
 * 1. **探测永不抛。** 探测的是可选设施；一次探测把插件打崩，比探测不到更糟。
 * 2. **不猜。** 问不出来的字段是 `null`，不是 `0` / `false`。`0` 的意思是"确实
 *    没有"，`null` 的意思是"我们没能问出来"—— 对读 V4 结论的人来说这两句话
 *    完全相反，所以它们必须是两个不同的值。
 *
 * 运行：`node --test test/`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { OWN_PACKAGE, countEntries, describeClientHalf, describeTypert } from '../src/host/capabilities.js'

test('countEntries：数不出来返回 null，绝不返回 0 冒充"确实没有"', () => {
  assert.equal(countEntries([1, 2, 3]), 3)
  assert.equal(countEntries([]), 0)
  assert.equal(countEntries(new Set(['a', 'b'])), 2)
  assert.equal(countEntries(undefined), null)
  assert.equal(countEntries(null), null)
  assert.equal(countEntries({ length: 3 }), null)
  assert.equal(countEntries(42), null)
  // 可迭代但对到一半抛错的，也只能算"问不出来"。
  const evil = {
    *[Symbol.iterator]() {
      yield 1
      throw new Error('boom')
    },
  }
  assert.equal(countEntries(evil), null)
})

test('describeTypert：宿主没挂注册表时如实降级，并给出原因', () => {
  const missing = describeTypert(() => undefined)
  assert.equal(missing.available, false)
  assert.match(String(missing.reason), /ctx\.typert/)
  // 没探测到，就不能顺手把"没有本插件产物"也一并断言了。
  assert.equal(missing.ownPackageRegistered, null)
  assert.equal(missing.packages, null)
})

test('describeTypert：取服务时抛错也不能把插件带崩', () => {
  const report = describeTypert(() => {
    throw new Error('服务解析失败')
  })
  assert.equal(report.available, false)
  assert.match(String(report.reason), /服务解析失败/)
})

test('describeTypert：注册表存在时报告包数与样例，并认出本插件', () => {
  const registry = {
    listPackages: () => [{ name: '@deepseek-ai/dsh-agent' }, { name: OWN_PACKAGE }, { name: '@deepseek-ai/dsh-api-gateway' }],
    list: () => [1, 2, 3, 4],
    local: { list: () => [1, 2] },
    remotes: { list: () => [1] },
  }
  const report = describeTypert((key) => (key === 'typert' ? registry : undefined))
  assert.equal(report.available, true)
  assert.equal(report.packages, 3)
  assert.equal(report.schemas, 4)
  // V4 的判据读的是 local 描述符，不是 schema 条数 —— 两者不能混为一谈。
  assert.equal(report.descriptors, 2)
  assert.equal(report.remoteDescriptors, 1)
  assert.equal(report.ownPackageRegistered, true)
  assert.deepEqual(report.sample, ['@deepseek-ai/dsh-agent', OWN_PACKAGE, '@deepseek-ai/dsh-api-gateway'])
  assert.equal(report.reason, null)
})

test('describeTypert：注册表是空的 —— 这才有资格说"没有本插件产物"', () => {
  const report = describeTypert(() => ({ listPackages: () => [], list: () => [], local: { list: () => [] } }))
  assert.equal(report.available, true)
  assert.equal(report.packages, 0)
  assert.equal(report.schemas, 0)
  assert.equal(report.descriptors, 0)
  assert.equal(report.ownPackageRegistered, false)
})

test('describeTypert：样例被截断不影响结论 —— 本插件排在第 6 位也要被认出来', () => {
  // 6 个包，本插件排在第 6 位，而样例只显示前 5 条。样例短是为了让人看得清，
  // **不是**判断依据：遍历必须走完整个列表，否则"没在样例里"会被误读成"没注册"。
  const many = Array.from({ length: 5 }, (_, i) => ({ name: `pkg-${i}` })).concat([{ name: OWN_PACKAGE }])
  const report = describeTypert(() => ({ listPackages: () => many, list: () => [] }))
  assert.equal(report.packages, 6)
  assert.equal(report.ownPackageRegistered, true)
  assert.equal(report.sample.length, 5)
})

test('describeTypert：注册表返回只能消费一次的迭代器时，一趟遍历必须拿到全部三个结论', () => {
  // 真实的注册表可能返回迭代器而不是数组。若为了"计数"和"看名字"各走一遍，
  // 第二遍就是空的 —— 于是会得出"包数为 0 / 本插件没注册"这种看起来确定的错答案。
  let passes = 0
  const registry = {
    listPackages: () => ({
      *[Symbol.iterator]() {
        passes += 1
        yield { name: '@deepseek-ai/dsh-base' }
        yield { name: OWN_PACKAGE }
      },
    }),
    list: () => [],
  }
  const report = describeTypert(() => registry)
  assert.equal(passes, 1)
  assert.equal(report.packages, 2)
  assert.equal(report.ownPackageRegistered, true)
  assert.deepEqual(report.sample, ['@deepseek-ai/dsh-base', OWN_PACKAGE])
})

test('describeTypert：遍历到一半失败时，总数与"有没有本插件"都只能说"没问出来"', () => {
  const registry = {
    listPackages: () => ({
      *[Symbol.iterator]() {
        yield { name: '@deepseek-ai/dsh-base' }
        throw new Error('列表读到一半断了')
      },
    }),
    list: () => [],
  }
  const report = describeTypert(() => registry)
  assert.equal(report.available, true)
  assert.equal(report.packages, null)
  assert.equal(report.ownPackageRegistered, null)
})

test('describeTypert：子调用抛错时保留"注册表可用"这一事实，只把该字段置空', () => {
  const registry = {
    listPackages: () => {
      throw new Error('listPackages 坏了')
    },
    list: () => [1],
    local: { list: () => [1, 2, 3] },
  }
  const report = describeTypert(() => registry)
  assert.equal(report.available, true)
  assert.equal(report.packages, null)
  assert.equal(report.schemas, 1)
  assert.equal(report.descriptors, 3)
  assert.match(String(report.reason), /listPackages/)
})

test('describeTypert：注册表没有 list() 时给 null，不给 0', () => {
  const report = describeTypert(() => ({ listPackages: () => [{ name: 'x' }] }))
  assert.equal(report.packages, 1)
  assert.equal(report.schemas, null)
  assert.equal(report.descriptors, null)
  assert.equal(report.remoteDescriptors, null)
})

test('describeTypert：local 仓或它的 list() 坏掉时，V4 判据是 null 而不是 0', () => {
  // `0` 的意思是"查过了，一个描述符都没有"——那是一个足以支撑"不迁移"结论的
  // 硬事实。而"取不到"只能支撑"这次没测出来"。两者绝不能写成同一个值。
  const broken = describeTypert(() => ({
    listPackages: () => [],
    list: () => [],
    local: {
      list: () => {
        throw new Error('local.list 坏了')
      },
    },
    remotes: 'not-an-object',
  }))
  assert.equal(broken.available, true)
  assert.equal(broken.descriptors, null)
  assert.equal(broken.remoteDescriptors, null)

  // getter 自己抛也不能把探测带崩。
  const hostile = describeTypert(() => ({
    listPackages: () => [],
    list: () => [],
    get local() {
      throw new Error('getter 抛了')
    },
  }))
  assert.equal(hostile.available, true)
  assert.equal(hostile.descriptors, null)
})

test('describeTypert：畸形输入不能抛（get 不是函数、注册表是数字、迭代器抛错）', () => {
  assert.doesNotThrow(() => describeTypert(undefined))
  assert.equal(describeTypert(undefined).available, false)
  assert.equal(describeTypert(() => 42).available, false)
  assert.equal(describeTypert(() => 'typert').available, false)
  const evil = {
    listPackages: () => ({
      *[Symbol.iterator]() {
        throw new Error('boom')
      },
    }),
    list: () => undefined,
  }
  const report = describeTypert(() => evil)
  assert.equal(report.available, true)
  assert.equal(report.packages, null)
  assert.equal(report.descriptors, null)
})

test('describeClientHalf：没有 clientModules 服务时是"没观察能力"，不是"客户端没加载"', () => {
  const noGet = describeClientHalf(undefined)
  assert.equal(noGet.available, false)
  assert.equal(noGet.composed, null, '没有观察能力时 composed 必须是 null —— 不能说 false')
  assert.match(noGet.reason, /get 不是函数/)

  const noService = describeClientHalf(() => null)
  assert.equal(noService.available, false)
  assert.equal(noService.composed, null)
  assert.match(noService.reason, /ctx\.clientModules/)

  const thrower = describeClientHalf(() => {
    throw new Error('设施读取炸了')
  })
  assert.equal(thrower.available, false)
  assert.equal(thrower.composed, null)
  assert.match(thrower.reason, /设施读取炸了/)

  const noMethod = describeClientHalf(() => ({}))
  assert.equal(noMethod.available, false)
  assert.match(noMethod.reason, /clientPath/)
})

test('describeClientHalf：服务在但不为本包组出入口时，给出确定的坏消息与修法', () => {
  const report = describeClientHalf(() => ({ clientPath: () => undefined }))

  assert.equal(report.available, true)
  assert.equal(report.composed, false, '服务在、查得到、结果是空 —— 这才是确定的"没组合进来"')
  assert.equal(report.path, null)
  // 这条自诊断存在的全部意义：把修法直接写进 reason（平台在这条路上什么都不说）。
  assert.match(report.reason, /exports\["\.\/client"\]/)
  assert.match(report.reason, /npm run build/)
  assert.match(report.reason, /重启宿主/)
  assert.ok(report.reason.includes(OWN_PACKAGE), 'reason 必须点名是哪个包')
})

test('describeClientHalf：组好了就带路径，且路径为空串按"没组好"处理', () => {
  const ok = describeClientHalf(() => ({ clientPath: (id) => `/opt/x/${id}/lib/client.js` }))
  assert.equal(ok.available, true)
  assert.equal(ok.composed, true)
  assert.equal(ok.reason, null)
  assert.equal(ok.path, `/opt/x/${OWN_PACKAGE}/lib/client.js`)

  const blank = describeClientHalf(() => ({ clientPath: () => '' }))
  assert.equal(blank.composed, false, '空字符串不是路径')

  const wrongType = describeClientHalf(() => ({ clientPath: () => 42 }))
  assert.equal(wrongType.composed, false, '非字符串不是路径')
})

test('describeClientHalf：查询过程中抛错也不能把插件带崩，且不得谎报"没组合"', () => {
  const report = describeClientHalf(() => ({
    clientPath: () => {
      throw new Error('查询炸了')
    },
  }))
  assert.equal(report.available, false)
  assert.equal(report.composed, null, '查不动的时候说 false 就是在撒谎')
  assert.match(report.reason, /查询炸了/)

  assert.equal(describeClientHalf(() => '不是对象').composed, null)
  assert.equal(describeClientHalf(() => 0).composed, null)
})
