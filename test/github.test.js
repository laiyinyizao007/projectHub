import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchGitHubPortfolio, mergeHumanUpdates } from '../dsh/github.js'

/** 假 fetch：按 URL 形态返回夹具，验证 provider 的组装逻辑（不打真网络）。 */
function fakeFetch(groups, boardItems, subIssues = {}, comments = {}) {
  return async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {}
    const json = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) })
    if (url.includes('/search/issues')) return json({ items: groups })
    if (url.includes('/graphql')) {
      return json({ data: { repositoryOwner: { projectV2: {
        id: 'P1',
        fields: { nodes: [
          { __typename: 'ProjectV2Field', id: 'F_MOD', name: '大组' },
          { __typename: 'ProjectV2Field', id: 'F_STAT', name: '推进状态' },
          { __typename: 'ProjectV2Field', id: 'F_DDL', name: 'DDL' },
          { __typename: 'ProjectV2Field', id: 'F_OWN', name: '负责人' },
          { __typename: 'ProjectV2Field', id: 'F_PROG', name: '进度' },
          { __typename: 'ProjectV2Field', id: 'F_REPO', name: '仓库' },
        ] },
        items: { nodes: boardItems },
      } } } })
    }
    const m = /\/issues\/(\d+)\/sub_issues/.exec(url)
    if (m) return json(subIssues[m[1]] ?? [])
    const c = /\/issues\/(\d+)\/comments/.exec(url)
    if (c) return json(comments[c[1]] ?? [])
    throw new Error(`未预期的 URL: ${url}`)
  }
}

const GROUP = {
  id: 1,
  node_id: 'I_GROUP',
  number: 11,
  title: '🖥️ DSH 组',
  repository_url: 'https://api.github.com/repos/laiyinyizao007/dsh-desktop',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  labels: [{ name: 'type: group' }, { name: 'group:dsh' }],
  body: 'DeepSeek Harness 桌面端 + 插件群\n\n- 分类：效率工具\n- 主仓：dsh-desktop\n- 组内仓：dsh-desktop, dsh-desktop-responsive\n- 技术栈：JavaScript · Electron\n',
}

const ITEM = {
  id: 'ITEM1',
  content: { __typename: 'Issue', id: 'I_GROUP', title: '🖥️ DSH 组', number: 11 },
  fieldValues: { nodes: [
    { name: '效率工具', field: { name: '大组' } },
    { name: '进行中', field: { name: '推进状态' } },
    { name: '2026-12-01', field: { name: 'DDL' } },
    { name: '我', field: { name: '负责人' } },
    { number: 55, field: { name: '进度' } },
    { text: 'https://github.com/laiyinyizao007/dsh-desktop', field: { name: '仓库' } },
  ] },
}

test('GitHub 数据源产出与本地 store 同形状的项目记录', async () => {
  const fetchImpl = fakeFetch([GROUP], [ITEM], {
    11: [
      { number: 3, title: '修 widget 崩溃', state: 'open', assignee: { login: 'averypi' }, milestone: null },
      { number: 4, title: '加个开关', state: 'closed', closed_at: '2026-10-20T00:00:00Z', assignee: null, milestone: { due_on: '2026-10-18T00:00:00Z' } },
    ],
  })
  const { projects, meta } = await fetchGitHubPortfolio({
    fetchImpl, token: 't', owner: 'laiyinyizao007', projectNumber: 1,
  })
  assert.equal(projects.length, 1)
  const p = projects[0]
  assert.equal(p.id, 'group:dsh')
  assert.equal(p.name, '🖥️ DSH 组')
  assert.equal(p.module, '效率工具')          // 分类
  assert.equal(p.status, '进行中')            // 推进状态
  assert.equal(p.dueDate, '2026-12-01')       // DDL
  assert.equal(p.owner, '我')
  assert.equal(p.progress, 55)
  assert.equal(p.link, 'https://github.com/laiyinyizao007/dsh-desktop')
  assert.equal(p.summary, 'DeepSeek Harness 桌面端 + 插件群')
  assert.deepEqual(p.tags, [])                 // type: group / group:dsh 被剔除
  assert.equal(p.todos.length, 2)
  assert.equal(p.todos[0].done, false)
  assert.equal(p.todos[0].owner, 'averypi')
  assert.equal(p.todos[1].done, true)
  assert.equal(p.todos[1].doneAt, '2026-10-20')
  assert.equal(p.todos[1].dueDate, '2026-10-18')
  assert.equal(meta.source, 'github')
  assert.equal(meta.tasks, 2)
  assert.deepEqual(p._meta.repos, ['dsh-desktop', 'dsh-desktop-responsive'])
})

test('人工进展按项目 id 合并回 GitHub 来的记录', async () => {
  const fetchImpl = fakeFetch([GROUP], [ITEM])
  const { projects } = await fetchGitHubPortfolio({ fetchImpl, token: 't', owner: 'o', projectNumber: 1 })
  const local = [{ id: 'group:dsh', name: '🖥️ DSH 组', updates: [{ id: 'u1', at: '2026-11-01', kind: 'progress', text: '联调通过' }] }]
  mergeHumanUpdates(projects, local)
  assert.equal(projects[0].updates.length, 1)
  assert.equal(projects[0].updates[0].text, '联调通过')
})

test('没有令牌时 provider 直接报错（由调用方决定退回本地）', async () => {
  await assert.rejects(() => fetchGitHubPortfolio({ owner: 'o' }), /没有配置 GitHub 令牌/)
})

test('跨仓子任务的 id 用它自己所在的仓 —— 防止同号 issue 撞车误关', async () => {
  // 回归：组的主仓是 dsh-desktop，子任务来自 dsh-desktop 与 dsh-desktop-responsive，
  // 两者都有 #1。若 id 一律用主仓前缀，两个 #1 会撞成同一个 id，
  // diff 时会把一个已关闭的 issue 误判成"被勾选"而关掉另一个。
  const group = {
    id: 1, node_id: 'I_GROUP', number: 11, title: '🖥️ DSH 组',
    repository_url: 'https://api.github.com/repos/laiyinyizao007/dsh-desktop',
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
    labels: [{ name: 'type: group' }, { name: 'group:dsh' }],
    body: 'DSH\n\n- 分类：效率工具\n- 主仓：dsh-desktop\n- 组内仓：dsh-desktop, dsh-desktop-responsive\n- 技术栈：JavaScript\n',
  }
  const kids = [
    { number: 1, title: '本仓的 #1（已关闭）', state: 'closed', closed_at: '2026-10-01T00:00:00Z',
      repository_url: 'https://api.github.com/repos/laiyinyizao007/dsh-desktop', assignee: null, milestone: null },
    { number: 1, title: '插件仓的 #1（未关闭）', state: 'open',
      repository_url: 'https://api.github.com/repos/laiyinyizao007/dsh-desktop-responsive', assignee: null, milestone: null },
  ]
  const { projects } = await fetchGitHubPortfolio({
    fetchImpl: fakeFetch([group], [ITEM], { 11: kids }),
    token: 't', owner: 'laiyinyizao007', projectNumber: 1,
  })
  const ids = projects[0].todos.map((t) => t.id).sort()
  assert.deepEqual(ids, ['task:dsh-desktop#1', 'task:dsh-desktop-responsive#1'])
  const closed = projects[0].todos.filter((t) => t.done).length
  assert.equal(closed, 1, '只有真正关闭的那个是 done')
})

test('读路径带回组内仓清单', async () => {
  const fetchImpl = fakeFetch([GROUP], [ITEM], { 11: [] })
  const { projects } = await fetchGitHubPortfolio({
    fetchImpl, token: 't', owner: 'laiyinyizao007', projectNumber: 1,
  })
  assert.deepEqual(projects[0].repos, ['dsh-desktop', 'dsh-desktop-responsive'])
})

test('进展记录读回：评论里的标记还原 id 与类型', async () => {
  const fetchImpl = fakeFetch([GROUP], [ITEM], {}, {
    11: [
      { body: '联调通过\n\n<!-- dsh-progress:u_7 kind=progress -->', created_at: '2026-11-01T00:00:00Z' },
      { body: '普通评论，不是进展记录' },
    ],
  })
  const { projects } = await fetchGitHubPortfolio({
    fetchImpl, token: 't', owner: 'laiyinyizao007', projectNumber: 1,
  })
  assert.equal(projects[0].updates.length, 1, '只认带标记的评论')
  assert.equal(projects[0].updates[0].id, 'u_7')
  assert.equal(projects[0].updates[0].kind, 'progress')
  assert.equal(projects[0].updates[0].text, '联调通过')
})

test('看板条目超过 100 个时要分页拉全，不能只读第一页', async () => {
  // 真实规模：项目组 ~95 个 + 任务 ~70 个 = 170+ 条目。
  // 只取 items(first:100) 的话，后面的项目组在面板里就凭空消失了。
  const total = 150
  const groups = Array.from({ length: total }, (_, i) => ({
    id: i + 1,
    node_id: `I_G${i}`,
    number: i + 1,
    title: `组 ${i}`,
    repository_url: `https://api.github.com/repos/laiyinyizao007/repo-${i}`,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    labels: [{ name: 'type: group' }, { name: `group:g${i}` }],
    body: `第 ${i} 组\n\n- 分类：效率工具\n- 主仓：repo-${i}\n- 组内仓：repo-${i}\n- 技术栈：Python\n`,
  }))
  const items = groups.map((g, i) => ({
    id: `ITEM${i}`,
    content: { __typename: 'Issue', id: g.node_id, title: g.title, number: g.number },
    fieldValues: { nodes: [
      { name: '效率工具', field: { name: '分类' } },
      { name: '进行中', field: { name: '推进状态' } },
    ] },
  }))

  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {}
    const json = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) })
    if (url.includes('/search/issues')) {
      const page = Number(new URL(url).searchParams.get('page') ?? '1')
      const slice = page === 1 ? groups.slice(0, 100) : groups.slice(100)
      return json({ items: slice })
    }
    if (url.includes('/graphql')) {
      const after = body.variables?.after ?? null
      const start = after ? Number(after.replace('cursor-', '')) : 0
      const next = start + 100
      return json({ data: { repositoryOwner: { projectV2: {
        id: 'P1',
        fields: { nodes: [] },
        items: {
          nodes: items.slice(start, start + 100),
          pageInfo: { hasNextPage: next < total, endCursor: `cursor-${next}` },
        },
      } } } })
    }
    return json([])
  }

  const { projects } = await fetchGitHubPortfolio({
    fetchImpl, token: 't', owner: 'laiyinyizao007', projectNumber: 1,
  })
  assert.equal(projects.length, total, '两页都要读到')
  assert.equal(projects.at(-1).name, '组 149')
})
