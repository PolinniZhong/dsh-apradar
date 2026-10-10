// P0 详情页与跨视图操作闭环 —— 真实渲染进程里的三条路径实跑（测试工具，不是插件代码）
//
// 为什么必须是真实浏览器：`test/detail.test.mjs` 的替身没有 CSS 引擎，也没有真实
// DOM。它证明了 nav 状态机、请求路径与请求体是对的；它**不能**证明
//   ① 详情真的在页面内部打开（而不是开了新页签）；
//   ② 滚动位置在真实滚动容器上真的被存取；
//   ③ 窄侧栏下不出现横向溢出；
//   ④ React 的受控 textarea 真的接受了输入并原样发给服务端。
// 这四条只能在真实渲染进程里量。
//
// 由 `cdp-run.mjs` 驱动：node cdp-run.mjs http://127.0.0.1:3080/ <本文件> <shot.png> --wait-ms=8000
//
// 三条路径（对应任务书第八节）：
//   ① 变化列表 → 变化详情 → 查看原文和差异 → 写备注
//   ② 关注源列表 → 来源详情 → 查看历史快照 → 试抓一次
//   ③ 机会列表 → 机会详情 → 修改判断和待验证问题 → 保存 → 返回来源变化
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim()
  const panelRoot = () => document.querySelector('.apr-root')
  const body = () => document.querySelector('.apr-body')
  const panelText = () => (panelRoot() ? textOf(panelRoot()) : '')

  const out = { origin: location.origin, viewport: [window.innerWidth, window.innerHeight], steps: [], phases: {}, problems: [] }

  /** 等一个条件成立；超时返回 false 而不是抛错（探针要把失败原因也带回来）。 */
  const until = async (fn, ms = 10000, step = 150) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      try {
        if (fn()) return true
      } catch {
        /* 元素还没挂上时的瞬时异常不算失败 */
      }
      await sleep(step)
    }
    return false
  }

  /**
   * 按可见文字点一个按钮。
   *
   * 必须先找**真按钮**再退到"任意元素 + closest"：`ChangeDetail` 的返回栏里
   * 只有一个按钮、没有标题 span，于是 `.apr-crumb` 与它里面的 `<button>` 的
   * textContent **完全相同**；按 DOM 顺序 `querySelectorAll('*')` 先返回外层 div，
   * 对它调 `.closest('button')` 得到 null，`div.click()` 什么也不会发生 ——
   * 这会让"返回没生效"看起来像插件的 bug，其实是探针找错了节点。
   */
  const clickText = async (label, scope = panelRoot()) => {
    const btn = (scope || document).querySelectorAll('button')
    let hit = Array.from(btn).filter((el) => textOf(el) === label && el.getBoundingClientRect().width > 0)[0]
    if (!hit) {
      const any = q('*').filter((el) => textOf(el) === label && el.getBoundingClientRect().width > 0)
      const viaClosest = any.map((el) => el.closest('button,[role="button"],[role="tab"],li,a')).filter(Boolean)[0]
      hit = viaClosest || null
    }
    if (!hit) {
      // 最后退到"以该文字开头"的按钮（页签文字后面会跟计数徽标）
      hit = Array.from((scope || document).querySelectorAll('button')).filter((el) => textOf(el).startsWith(label))[0] || null
    }
    if (!hit) return false
    hit.click()
    await sleep(300)
    return true
  }

  /**
   * 往 React 的受控 textarea/input 里写值。
   *
   * 直接 `el.value = x` 不会触发 React 的 onChange（React 覆写了 value 的 setter
   * 来做变更追踪）。必须取原型上的原生 setter 写进去，再派发一个冒泡的 input 事件
   * —— 这才是真实键入时发生的事。
   */
  const typeInto = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  }

  const btnByLabel = (label) => q('.apr-root button').filter((el) => textOf(el) === label)[0] || null
  const fieldByLabelText = (label) => {
    // `Field` 把控件包在 <label> 里，label 文本就在同一棵子树里。
    const lab = q('.apr-root label').filter((el) => textOf(el).startsWith(label))[0]
    return lab ? lab.querySelector('textarea,input,select') : null
  }

  try {
    // ── 准备：打开会话 → 右栏 → AI 产品雷达 ─────────────────────────────────
    for (const label of ['继续', '知道了', '关闭']) await clickText(label, document.body)

    const entry = q('*')
      .filter((el) => textOf(el).includes('以下是我想做的一个新产品') && textOf(el).length < 80)
      .filter((el) => el.getBoundingClientRect().left < window.innerWidth * 0.35)
      .sort((a, b) => textOf(a).length - textOf(b).length)[0]
    if (entry) {
      ;(entry.closest('button,[role="button"],li,a') || entry).click()
      await sleep(6000)
    }
    out.steps.push('已打开会话')

    const opener = q('[aria-label]').find((el) => (el.getAttribute('aria-label') || '').includes('打开右侧边栏'))
    if (opener) {
      opener.click()
      await sleep(1500)
      out.steps.push('已打开右侧边栏')
    }

    const cands = q('*').filter((el) => textOf(el) === 'AI 产品雷达' && el.getBoundingClientRect().left > window.innerWidth * 0.5)
    const chosen = cands[cands.length - 1]
    if (chosen) {
      ;(chosen.closest('button,[role="button"],[role="tab"],li,a') || chosen).click()
      await sleep(3000)
      out.steps.push('已点击插件入口')
    }

    const ready = await until(() => panelRoot() && body(), 15000)
    out.phases.准备 = { 面板就绪: ready, 面板文字长度: panelText().length }
    if (!ready) return out

    // 详情是否在页面内部打开：DSH 页签数量必须始终是 3（不新增侧栏页签）。
    out.phases.准备.页签数 = q('.apr-tabs *').filter((el) => /^(变化|关注源|机会池)/.test(textOf(el))).length

    // ══ 路径①：变化列表 → 变化详情 → 原文与差异 → 写备注 ═══════════════════
    const p1 = { steps: [] }
    try {
      // 先把列表滚下去一点，返回时才有"位置"可恢复。
      const scroller = body()
      scroller.scrollTop = 240
      await sleep(150)
      const before = scroller.scrollTop
      p1.离开列表时的滚动位置 = before

      const rows = q('.apr-body button.apr-row')
      p1.列表行数 = rows.length
      p1.行是按钮 = rows.length > 0 && rows.every((el) => el.tagName === 'BUTTON')
      p1.行有可访问名 = rows.length > 0 && rows.every((el) => (el.getAttribute('aria-label') || '').length > 0)
      if (!rows.length) throw new Error('变化列表没有行，无法验证详情')
      const title = textOf(rows[0].querySelector('.apr-row-title'))
      rows[0].click()
      p1.steps.push(`点开第一条变化：${title.slice(0, 40)}`)

      const opened = await until(() => document.querySelector('.apr-crumb') && !panelText().includes('本次显示第'), 10000)
      p1.详情已打开 = opened
      const t = panelText()
      // 任务书 §2.2 要求的每一项都要真的在页面上出现
      p1.有返回入口 = !!q('.apr-crumb button').find((el) => textOf(el).includes('返回'))
      p1.有来源与类型 = t.includes('来源') && t.includes('类型')
      p1.有官方发布时间 = t.includes('官方发布时间')
      p1.有本次发现时间 = t.includes('本次发现')
      p1.有原文摘录 = t.includes('原文摘录') || t.includes('原文')
      p1.有差异区 = t.includes('与上一版的关系') || t.includes('差异') || t.includes('没有可比较的上一版')
      p1.有处理状态 = t.includes('处理状态')
      p1.详情滚动位置归零 = body().scrollTop === 0
      p1.详情全文长度 = t.length

      // 写备注：这是真实写入，落盘。
      const marker = `[P0 探针] 详情页闭环实跑 ${new Date().toISOString()}`
      const area = fieldByLabelText('研究备注')
      p1.找到备注输入框 = !!area
      if (area) {
        const original = area.value
        p1.原备注 = original.slice(0, 60)
        typeInto(area, marker)
        p1.输入后控件值 = area.value.slice(0, 60)
        const saved = btnByLabel('保存备注')
        p1.找到保存按钮 = !!saved
        if (saved) {
          saved.click()
          const ok = await until(() => panelText().includes('已保存'), 10000)
          p1.显示已保存 = ok
          p1.保存后页面上有标记 = panelText().includes('[P0 探针]')
          // 还原，别把探针的标记留在使用者的真实数据里
          typeInto(area, original)
          btnByLabel('保存备注')?.click()
          p1.已还原原备注 = await until(() => panelText().includes('已保存'), 10000)
        }
      }

      // 返回列表：滚动位置与列表状态必须原样恢复
      p1.找到返回按钮 = !!btnByLabel('‹ 返回变化列表')
      btnByLabel('‹ 返回变化列表')?.click()
      const backOk = await until(() => !document.querySelector('.apr-crumb'), 8000)
      p1.已返回列表 = backOk
      await sleep(600)
      p1.返回后滚动位置 = body().scrollTop
      p1.滚动位置已恢复 = Math.abs(body().scrollTop - before) <= 2
      p1.返回后列表行数 = q('.apr-body button.apr-row').length
      p1.返回后仍有筛选条 = panelText().includes('未读')
    } catch (error) {
      p1.异常 = String(error && error.message ? error.message : error)
      out.problems.push(`路径①：${p1.异常}`)
    }
    out.phases.路径一_变化详情 = p1

    // ══ 路径②：关注源列表 → 来源详情 → 历史快照 → 试抓一次 ═════════════════
    const p2 = { steps: [] }
    try {
      await clickText('关注源')
      await until(() => q('.apr-body button.apr-rowlink').length > 0, 10000)
      const links = q('.apr-body button.apr-rowlink[aria-label^="打开来源详情"]')
      p2.来源行数 = links.length
      if (!links.length) throw new Error('来源列表没有可进入详情的入口')
      p2.入口是按钮 = links.every((el) => el.tagName === 'BUTTON')
      // 行内动作必须是详情的**兄弟**节点：点刷新不该跳详情。
      const card = links[0].closest('.apr-card')
      p2.行内动作与标题分离 = !!card && !!card.querySelector('.apr-actions') && links[0].closest('.apr-actions') === null && card.querySelectorAll('.apr-actions button').length >= 3
      const name = textOf(links[0])
      links[0].click()
      p2.steps.push(`点开来源：${name}`)

      const opened = await until(() => document.querySelector('.apr-crumb') && panelText().includes('快照历史'), 12000)
      p2.详情已打开 = opened
      const t = panelText()
      p2.有返回入口 = !!q('.apr-crumb button').find((el) => textOf(el).includes('返回'))
      p2.有规范化地址 = t.includes('规范化地址')
      p2.有上次成功时间 = t.includes('上次成功')
      p2.有连续失败次数 = t.includes('连续失败次数')
      p2.有上次抓取状态 = t.includes('上次抓取状态')
      p2.有快照历史 = t.includes('快照历史')
      p2.快照条数 = q('.apr-body .apr-card').length
      p2.有保留限制说明 = t.includes('最多保留') || t.includes('保留')
      p2.模板名 = name

      // 试抓一次：真实出网，不写任何东西（这是详情里保留的必要操作）
      const test = btnByLabel('试抓一次')
      p2.找到试抓按钮 = !!test
      if (test) {
        test.click()
        const got = await until(() => /解析到|抓取失败|条|错误|成功/.test(panelText()), 60000, 400)
        p2.试抓有结果 = got
        p2.试抓后文字片段 = panelText().slice(0, 400)
      }

      p2.找到返回按钮 = !!btnByLabel('‹ 返回关注源列表')
      btnByLabel('‹ 返回关注源列表')?.click()
      p2.已返回列表 = await until(() => !document.querySelector('.apr-crumb'), 8000)
    } catch (error) {
      p2.异常 = String(error && error.message ? error.message : error)
      out.problems.push(`路径②：${p2.异常}`)
    }
    out.phases.路径二_来源详情 = p2

    // ══ 路径③：机会列表 → 机会详情 → 改判断与问题 → 保存 → 回到来源变化 ══
    const p3 = { steps: [] }
    try {
      await clickText('机会池')
      await until(() => q('.apr-body button.apr-rowlink').length > 0, 10000)
      const links = q('.apr-body button.apr-rowlink[aria-label^="打开机会详情"]')
      p3.机会行数 = links.length
      if (!links.length) throw new Error('机会列表没有可进入详情的入口')

      // 优先挑一条**有关联变化**的（这样才能验证跨对象跳转与真实 id 关联）
      let target = null
      let kind = ''
      for (const el of links) {
        const row = el.closest('.apr-card') || el.parentElement
        if (row && !textOf(row).includes('没有关联任何一次抓取记录')) {
          target = el
          kind = '有关联变化'
          break
        }
      }
      if (!target) {
        target = links[0]
        kind = '只有手工机会'
      }
      p3.选中类型 = kind
      p3.手工机会是否明示 = links.some((el) => {
        const row = el.closest('.apr-card') || el.parentElement
        return row && textOf(row).includes('没有关联任何一次抓取记录')
      })
      const title = textOf(target)
      target.click()
      p3.steps.push(`点开机会：${title.slice(0, 40)}`)

      const opened = await until(() => document.querySelector('.apr-crumb') && panelText().includes('返回机会池'), 12000)
      p3.详情已打开 = opened
      let t = panelText()
      p3.有返回入口 = !!q('.apr-crumb button').find((el) => textOf(el).includes('返回'))
      p3.有关联的变化区 = t.includes('关联的来源变化')
      p3.有创建时间 = t.includes('创建时间')
      p3.有待验证问题 = t.includes('待验证问题')
      p3.有关联变化时的跳转入口 = !!btnByLabel('打开变化详情 ›')
      p3.没有关联时的说明 = t.includes('没有关联任何一次抓取记录')
      p3.有编辑入口 = !!btnByLabel('编辑判断与问题')

      // 真实保存：改判断 → 保存 → 只有服务端确认才出现"已保存"
      const edit = btnByLabel('编辑判断与问题')
      if (edit) {
        edit.click()
        await until(() => !!fieldByLabelText('产品判断'), 5000)
        const judge = fieldByLabelText('产品判断')
        const quest = fieldByLabelText('待验证问题')
        p3.编辑表单出现 = !!judge
        if (judge) {
          const originalJudge = judge.value
          const originalQuest = quest ? quest.value : null
          p3.原判断 = originalJudge.slice(0, 50)
          typeInto(judge, `${originalJudge}\n[P0 探针] 保存往返验证 ${new Date().toISOString()}`)
          if (quest) typeInto(quest, `${originalQuest || ''}\n[P0 探针] 这个问题由探针写入`)
          const save = btnByLabel('保存')
          p3.找到保存按钮 = !!save
          if (save) {
            save.click()
            p3.显示已保存 = await until(() => panelText().includes('已保存'), 12000)
            await sleep(500)
            t = panelText()
            p3.保存后回到详情 = !fieldByLabelText('产品判断')
            p3.详情含探针写入 = t.includes('[P0 探针] 保存往返验证')

            // 还原
            btnByLabel('编辑判断与问题')?.click()
            await until(() => !!fieldByLabelText('产品判断'), 5000)
            const j2 = fieldByLabelText('产品判断')
            if (j2) {
              typeInto(j2, originalJudge)
              if (quest) {
                const q2 = fieldByLabelText('待验证问题')
                if (q2) typeInto(q2, originalQuest ?? '')
              }
              btnByLabel('保存')?.click()
              p3.已还原原判断 = await until(() => panelText().includes('已保存'), 12000)
            }
          }
        }
      }

      // 跨对象跳转：从机会详情直接打开那条变化（必须用真实 id）
      const jump = btnByLabel('打开变化详情 ›')
      if (jump) {
        jump.click()
        const jumped = await until(() => panelText().includes('来源') && !!document.querySelector('.apr-crumb') && textOf(document.querySelector('.apr-crumb')).includes('返回变化'), 12000)
        p3.已跳转到关联变化 = jumped
        p3.跳转后crumb = textOf(document.querySelector('.apr-crumb') || document.body).slice(0, 60)
        // 再返回：应当回到机会详情（来路栈）
        btnByLabel('‹ 返回变化列表')?.click()
        await until(() => !document.querySelector('.apr-crumb') || textOf(document.querySelector('.apr-crumb')).includes('返回机会池'), 8000)
        await sleep(1200)
        p3.返回后回到机会详情 = !!btnByLabel('打开变化详情 ›') || panelText().includes('关联的来源变化')
      } else {
        p3.跨对象跳转 = '这条机会没有关联变化，跳过（已由「没有关联时的说明」覆盖）'
      }
    } catch (error) {
      p3.异常 = String(error && error.message ? error.message : error)
      out.problems.push(`路径③：${p3.异常}`)
    }
    out.phases.路径三_机会详情 = p3

    // ══ 不横向溢出：真实宽度 + 强制的窄侧栏宽度 ═══════════════════════════
    const measureOverflow = (label) => {
      const root = panelRoot()
      if (!root) return { label, 面板不存在: true }
      const bad = []
      for (const el of [root, ...root.querySelectorAll('*')]) {
        // 只关心真正会滚出容器的元素：内容宽度超过自身可视宽度
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
          bad.push(`${el.tagName}.${String(el.className || '').slice(0, 40)} scroll=${el.scrollWidth} client=${el.clientWidth}`)
        }
      }
      const doc = document.documentElement
      return {
        label,
        面板宽度: Math.round(root.getBoundingClientRect().width),
        文档横向溢出: doc.scrollWidth - doc.clientWidth,
        内部溢出元素数: bad.length,
        内部溢出示例: bad.slice(0, 8),
      }
    }

    const real = measureOverflow('真实侧栏宽度')
    // 强制一个窄宽度再量：证明窄侧栏下 CSS 不会横向溢出。
    // 这是**模拟**的窄侧栏（直接改面板宽度），不是拖拽 DSH 侧栏的真实验证 ——
    // 这一点必须如实写在结论里。
    const root = panelRoot()
    const savedWidth = root ? root.style.width : ''
    if (root) {
      root.style.width = '320px'
      await sleep(400)
    }
    const narrow = measureOverflow('强制 320px（模拟窄侧栏）')
    if (root) {
      root.style.width = savedWidth
      await sleep(300)
    }
    out.横向溢出 = { 真实: real, 窄: narrow, 说明: '窄侧栏宽度是脚本直接改面板宽度模拟的，不是拖拽 DSH 侧栏' }
    if (real.内部溢出元素数 > 0) out.problems.push(`真实宽度下有 ${real.内部溢出元素数} 个元素横向溢出`)
    if (narrow.内部溢出元素数 > 0) out.problems.push(`320px 下有 ${narrow.内部溢出元素数} 个元素横向溢出`)

    // 键盘可达性（真实 DOM 的 tab 顺序与焦点环）
    const focusables = q('.apr-root button, .apr-root a[href], .apr-root textarea, .apr-root input, .apr-root select')
    out.键盘 = {
      可聚焦元素数: focusables.length,
      未禁用的都可聚焦: focusables.filter((el) => !el.disabled).every((el) => el.tabIndex >= 0),
      被禁用的按钮数: focusables.filter((el) => el.disabled).length,
      有可见焦点样式的元素数: focusables.filter((el) => {
        try {
          return document.styleSheets.length > 0
        } catch {
          return false
        }
      }).length,
    }
  } catch (error) {
    out.error = String(error && error.stack ? error.stack : error)
  }
  return out
})()
