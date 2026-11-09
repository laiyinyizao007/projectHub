import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchGitHubPortfolio, mergeHumanUpdates } from '../dsh/github.js'

/** 假 fetch：按 URL 形态返回夹具，验证 provider 的组装逻辑（不打真网络）。 */
function fakeFetch(groups, boardItems, subIssues = {}) {
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
