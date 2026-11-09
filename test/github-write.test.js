import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPortfolioChanges } from '../dsh/github.js'

/** 记录所有写操作，并按需返回夹具。 */
function recorder({ groupIssues = [], boardItems = [], issues = [], comments = {}, failGraphql = false } = {}) {
  const writes = []
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url, method: init.method ?? 'GET', body })
    const json = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) })
    if (url.includes('/graphql')) {
      if (failGraphql) throw new Error('网络中断')
      const query = body?.query ?? ''
      if (query.includes('projectV2(number: $num) { id }') || query.includes('projectV2(number:$num){id}')) {
        return json({ data: { repositoryOwner: { projectV2: { id: 'P1' } } } })
      }
      if (query.includes('items(first: 100')) {
        return json({ data: { repositoryOwner: { projectV2: {
          id: 'P1',
          fields: { nodes: [
            { __typename: 'ProjectV2Field', id: 'F_PROG', name: '进度' },
            { __typename: 'ProjectV2Field', id: 'F_DDL', name: 'DDL' },
            { __typename: 'ProjectV2Field', id: 'F_OWN', name: '负责人' },
            { __typename: 'ProjectV2SingleSelectField', id: 'F_STAT', name: '推进状态',
              options: [{ id: 'O_WIP', name: '进行中' }, { id: 'O_IDLE', name: '休眠' }] },
          ] },
          items: { nodes: boardItems },
        } } } })
      }
      if (query.includes('updateProjectV2ItemFieldValue')) {
        writes.push({ type: 'field', ...body.variables })
        return json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'I1' } } } })
      }
      if (query.includes('addProjectV2ItemById')) {
        writes.push({ type: 'add-to-project', ...body.variables })
        return json({ data: { addProjectV2ItemById: { projectV2Item: { id: 'I1' } } } })
      }
      if (query.includes('repository(owner:$owner,name:$repo)')) {
        return json({ data: { repository: { issue: { id: 'I_NEW', number: 99 } } } })
      }
      throw new Error('未预期的 GraphQL: ' + query.slice(0, 60))
    }
    if (url.includes('/comments?per_page=100')) {
      const m = /\/issues\/(\d+)\/comments/.exec(url)
      return json(comments[m?.[1]] ?? [])
    }
    if (url.includes('/comments')) {
      writes.push({ type: 'create-comment', url, body })
      return json({})
    }
    if (url.includes('/issues') && init.method === 'POST') {
      writes.push({ type: 'create-issue', url, body })
      return json({ number: 99 })
    }
    if (url.includes('/issues') && init.method === 'PATCH') {
      writes.push({ type: 'patch-issue', url, body })
      return json({})
    }
    if (url.includes('/search/issues')) return json({ items: groupIssues })
    throw new Error('未预期的 URL: ' + url)
  }
  return { fetchImpl, writes, calls }
}

const GROUP_ISSUE = {
  id: 1, node_id: 'I_GROUP', number: 11, title: '🖥️ DSH 组',
  repository_url: 'https://api.github.com/repos/laiyinyizao007/dsh-desktop',
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
  labels: [{ name: 'type: group' }, { name: 'group:dsh' }],
  body: 'DSH\n\n- 分类：效率工具\n- 主仓：dsh-desktop\n- 组内仓：dsh-desktop\n- 技术栈：JavaScript\n',
}

const BOARD_ITEM = {
  id: 'ITEM1',
  content: { __typename: 'Issue', id: 'I_GROUP', title: '🖥️ DSH 组', number: 11 },
  fieldValues: { nodes: [
    { name: '效率工具', field: { name: '分类' } },
    { name: '进行中', field: { name: '推进状态' } },
    { number: 10, field: { name: '进度' } },
    { text: '我', field: { name: '负责人' } },
  ] },
}

const PREVIOUS = [{
  id: 'group:dsh', name: '🖥️ DSH 组', module: '效率工具', status: '进行中',
  owner: '我', dueDate: '', progress: 10, link: 'https://github.com/laiyinyizao007/dsh-desktop',
  summary: 'DSH', tags: [], createdAt: '', updatedAt: '', updates: [],
  todos: [{ id: 'task:dsh-desktop#3', title: '修 bug', owner: '', dueDate: '', done: false, doneAt: '' }],
  _meta: { key: 'dsh', nodeId: 'I_GROUP', repo: 'dsh-desktop', repos: ['dsh-desktop'] },
}]

test('只写白名单字段：进度变了才写，名字/模块变了不写', async () => {
  const { fetchImpl, writes } = recorder({ boardItems: [BOARD_ITEM] })
  const next = [{
    ...PREVIOUS[0],
    name: '改了名字不该写',
    module: '也改了模块',
    progress: 55,            // ← 只有它变了
    dueDate: '2026-12-01',   // ← 之前是空
    status: '休眠',
    owner: '别人',
  }]
  const summary = await applyPortfolioChanges({
    fetchImpl, token: 't', owner: 'o', projectNumber: 1, previous: PREVIOUS, next,
  })
  const fields = writes.filter((w) => w.type === 'field')
  const names = fields.map((f) => f.fid)
  assert.ok(fields.length > 0, '应该至少写了一个字段')
  assert.ok(!names.includes('F_MOD'), '不该有模块字段（这里没有该字段 id）')
  assert.equal(fields.filter((f) => f.fid === 'F_PROG').length, 1, '进度应写一次')
  assert.equal(fields.filter((f) => f.fid === 'F_DDL').length, 1, 'DDL 应写一次')
  assert.equal(fields.filter((f) => f.fid === 'F_STAT').length, 1, '推进状态应写一次')
  assert.equal(fields.filter((f) => f.fid === 'F_OWN').length, 1, '负责人应写一次')
  assert.equal(summary.updated.length, 4)
})

test('勾选待跟进 → 关掉对应的 GitHub issue', async () => {
  const { fetchImpl, writes } = recorder({ boardItems: [BOARD_ITEM] })
  const next = [{
    ...PREVIOUS[0],
    todos: [{ ...PREVIOUS[0].todos[0], done: true, doneAt: '2026-11-09' }],
  }]
  const summary = await applyPortfolioChanges({
    fetchImpl, token: 't', owner: 'o', projectNumber: 1, previous: PREVIOUS, next,
  })
  const patch = writes.find((w) => w.type === 'patch-issue')
  assert.ok(patch, '应该 PATCH 了这个 issue')
  assert.match(patch.url, /dsh-desktop\/issues\/3$/)
  assert.equal(patch.body.state, 'closed')
  assert.equal(summary.closedTasks.length, 1)
})

test('本地台账里的项目（id 不是 group:）不会被推到 GitHub', async () => {
  const { fetchImpl, writes } = recorder({ boardItems: [BOARD_ITEM] })
  const summary = await applyPortfolioChanges({
    fetchImpl, token: 't', owner: 'o', projectNumber: 1, previous: PREVIOUS,
    next: [{ id: 'local-uuid-1234', name: '本地项目', link: '' }],
  })
  assert.equal(writes.filter((w) => w.type === 'create-issue').length, 0)
  assert.equal(summary.skipped.length, 1)
  assert.match(summary.skipped[0].why, /仅存本地/)
})

test('远端读失败 → 直接抛错，一个字都不写', async () => {
  const { fetchImpl, writes } = recorder({ boardItems: [BOARD_ITEM], failGraphql: true })
  await assert.rejects(
    () => applyPortfolioChanges({ fetchImpl, token: 't', owner: 'o', projectNumber: 1, previous: PREVIOUS, next: PREVIOUS }),
    /网络中断/,
  )
  assert.equal(writes.length, 0, '读失败时不应有任何写操作')
})

test('进展记录写回：发成项目组 Issue 的评论，按标记幂等', async () => {
  const { fetchImpl, writes } = recorder({ boardItems: [BOARD_ITEM] })
  const previous = [{ ...PREVIOUS[0], updates: [{ id: 'u_old', kind: 'progress', text: '旧进展' }] }]
  const next = [{
    ...PREVIOUS[0],
    updates: [
      { id: 'u_old', kind: 'progress', text: '旧进展' },        // 已同步过 → 不该重发
      { id: 'u_new', kind: 'blocker', text: '新阻塞' },          // 新的 → 要发
    ],
  }]
  const summary = await applyPortfolioChanges({
    fetchImpl, token: 't', owner: 'o', projectNumber: 1, previous, next,
  })
  const comments = writes.filter((w) => w.type === 'create-comment')
  assert.equal(comments.length, 1, '只应发一条新评论')
  assert.match(comments[0].body.body, /新阻塞/)
  assert.match(comments[0].body.body, /<!--\s*dsh-progress:u_new kind=blocker\s*-->/)
  assert.equal(summary.progress.length, 1)
})
