/**
 * GitHub 数据源：把「项目组 → 任务」的原生层级读出来，产出与本地 store **相同形状**的项目记录。
 *
 * 为什么走 GitHub 而不是本地 state.json：
 *   真正的项目结构（谁属于哪个组、任务挂在谁下面、DDL、进度）本来就在 GitHub 上——
 *   Issue + Projects v2 字段 + 原生 sub-issue。台账只应该在 GitHub 一处，
 *   再存一份必然漂移。本模块只**读**，把结构翻译成工作台认识的样子。
 *
 * 形状对齐（见 store.js 的 sanitizeProject）：
 *   { id, name, module, status, owner, dueDate, startedOn, progress, link,
 *     summary, tags, createdAt, updatedAt, updates[], todos[] }
 *
 * id 用 `group:<key>`（取自项目组 Issue 的 group: 标签），稳定且可与本地人工记录关联。
 */

const GROUP_LABEL = 'type: group'
const GROUP_KEY_PREFIX = 'group:'
const API = 'https://api.github.com'
const GRAPHQL = 'https://api.github.com/graphql'

/** 项目组 Issue 的正文里存了这些行（由建组脚本写入）。 */
function parseBody(body) {
  const text = String(body ?? '')
  const line = (label) => {
    const m = new RegExp(`^-\\s*${label}：(.+)$`, 'm').exec(text)
    return m ? m[1].trim() : ''
  }
  const repos = line('组内仓').split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean)
  const desc = text.split(/\n\s*\n/)[0]?.trim() ?? ''
  return {
    desc,
    primary: line('主仓'),
    repos,
    stack: line('技术栈'),
  }
}

async function gh(fetchImpl, url, { token, method = 'GET', body } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`GitHub ${method} ${url.replace(API, '')} → HTTP ${res.status} ${detail.slice(0, 200)}`)
  }
  return res.json()
}

/** 找出账号下所有项目组 Issue（带 type: group 标签）。 */
async function fetchGroupIssues(fetchImpl, { token, owner }) {
  const q = `user:${owner} label:"${GROUP_LABEL}" type:issue`
  const url = `${API}/search/issues?q=${encodeURIComponent(q)}&per_page=100`
  const data = await gh(fetchImpl, url, { token })
  return data.items ?? []
}

/** 取 Project v2 的字段定义与每个条目的字段值。 */
async function fetchProjectItems(fetchImpl, { token, owner, projectNumber }) {
  const query = `
query($login: String!, $num: Int!) {
  repositoryOwner(login: $login) {
    ... on User { projectV2(number: $num) { id fields(first: 50) { nodes {
      __typename
      ... on ProjectV2Field { id name }
      ... on ProjectV2SingleSelectField { id name options { id name } }
    } } items(first: 100) { nodes {
      id
      content { __typename ... on Issue { id title number } }
      fieldValues(first: 20) { nodes {
        ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
      } }
    } } } }
  }
}`
  const res = await fetchImpl(GRAPHQL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables: { login: owner, num: projectNumber } }),
  })
  const data = await res.json()
  if (data.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${data.errors.map((e) => e.message).join('; ')}`)
  }
  const project = data.data?.repositoryOwner?.projectV2
  if (!project) throw new Error(`找不到 Project #${projectNumber}（owner=${owner}）`)

  const fields = {}
  for (const f of project.fields.nodes) {
    if (!f?.name) continue
    // 选项归一化成 { 选项名: 选项 id }，写回时按名字查 id
    const options = {}
    for (const o of f.options ?? []) options[o.name] = o.id
    fields[f.name] = { id: f.id, options }
  }
  const byIssue = {}
  for (const node of project.items.nodes) {
    const content = node.content
    if (content?.__typename !== 'Issue' || !content.id) continue
    const values = {}
    for (const fv of node.fieldValues?.nodes ?? []) {
      const name = fv.field?.name
      if (!name) continue
      values[name] = fv.name ?? fv.text ?? fv.number ?? fv.date ?? ''
    }
    byIssue[content.id] = { title: content.title, number: content.number, values, itemId: node.id }
  }
  return { fields, byIssue }
}

/** 取某个项目组 Issue 的子任务（原生 sub-issue，跨仓也算）。 */
async function fetchSubIssues(fetchImpl, { token, owner, repo, number }) {
  const url = `${API}/repos/${owner}/${repo}/issues/${number}/sub_issues?per_page=100`
  const list = await gh(fetchImpl, url, { token })
  return Array.isArray(list) ? list : []
}

/**
 * 组装工作台的项目列表。
 * 返回 { projects, meta } —— meta 记录数据来源与统计，便于 /meta 端点透出。
 */
export async function fetchGitHubPortfolio({
  fetchImpl = globalThis.fetch,
  token,
  owner,
  projectNumber = 1,
} = {}) {
  if (!token) throw new Error('没有配置 GitHub 令牌')
  if (!owner) throw new Error('没有配置 GitHub 账号')

  const groups = await fetchGroupIssues(fetchImpl, { token, owner })
  const { fields, byIssue } = await fetchProjectItems(fetchImpl, { token, owner, projectNumber })

  const projects = []
  for (const issue of groups) {
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
    const key = labels.find((l) => l.startsWith(GROUP_KEY_PREFIX))?.slice(GROUP_KEY_PREFIX.length)
    if (!key) continue

    const repoName = String(issue.repository_url ?? '').split('/').pop()
    const meta = parseBody(issue.body)
    const board = byIssue[issue.node_id] ?? { values: {} }
    const v = board.values ?? {}

    // 子任务：项目组 Issue 的原生 sub-issue（可能分布在组内多个仓）
    let children = []
    try {
      children = await fetchSubIssues(fetchImpl, { token, owner, repo: repoName, number: issue.number })
    } catch {
      children = []
    }
    // 子任务可能分布在组内的**其他仓**（组是跨仓的）——
    // id 必须用子任务自己所在的仓，否则 github-weekly-progress#1 会被编成
    // task:my-project-management#1，和真正的同号 issue 撞在一起，
    // diff 时会把不相关的 issue 关掉。
    const seen = new Set()
    const todos = []
    for (const c of children) {
      const childRepo = String(c.repository_url ?? '').split('/').pop() || repoName
      const id = `task:${childRepo}#${c.number}`
      if (seen.has(id)) continue
      seen.add(id)
      todos.push({
        id,
        title: c.title ?? '',
        owner: (c.assignee?.login ?? ''),
        dueDate: c.milestone?.due_on ? String(c.milestone.due_on).slice(0, 10) : '',
        done: c.state === 'closed',
        doneAt: c.closed_at ? String(c.closed_at).slice(0, 10) : '',
      })
    }

    projects.push({
      id: `group:${key}`,
      name: issue.title ?? '',
      module: String(v['分类'] ?? v['大组'] ?? v['模块'] ?? '未分类'),
      status: String(v['推进状态'] ?? v['状态'] ?? '进行中'),
      owner: String(v['负责人'] ?? ''),
      dueDate: String(v['DDL'] ?? '').slice(0, 10),
      startedOn: String(issue.created_at ?? '').slice(0, 10),
      progress: Number.isFinite(Number(v['进度'])) ? Number(v['进度']) : 0,
      link: String(v['仓库'] ?? ''),
      summary: meta.desc,
      tags: labels.filter((l) => l !== GROUP_LABEL && !l.startsWith(GROUP_KEY_PREFIX)),
      createdAt: issue.created_at ?? '',
      updatedAt: issue.updated_at ?? '',
      updates: [],
      todos,
      // 额外信息（不进项目记录，但给 /meta 用）
      _meta: {
        key,
        primary: meta.primary || repoName,
        repos: meta.repos.length ? meta.repos : [repoName],
        stack: meta.stack,
        score: v['评分'],
        lastPush: v['最近推送'],
        issueNumber: issue.number,
        nodeId: issue.node_id,
        repo: repoName,
      },
    })
  }

  return {
    projects,
    meta: {
      source: 'github',
      owner,
      projectNumber,
      groups: projects.length,
      tasks: projects.reduce((n, p) => n + p.todos.length, 0),
    },
  }
}

/** 从本地 state.json 里按项目 id 取出人工进展记录，合并到 GitHub 来的项目上。 */
export function mergeHumanUpdates(projects, localProjects = []) {
  const byId = new Map(localProjects.map((p) => [p.id, p]))
  const byName = new Map(localProjects.map((p) => [p.name, p]))
  for (const p of projects) {
    const local = byId.get(p.id) ?? byName.get(p.name)
    if (local?.updates?.length) p.updates = local.updates
  }
  return projects
}

// ── 写回 GitHub ──────────────────────────────────────────────────

/**
 * 允许从工作台写回 GitHub 的字段**白名单**。
 * 只有这四个字段能从工作台改：进度 / DDL / 推进状态 / 负责人。
 * 其余（名称、模块、仓库、技术栈、进展记录）都不写回：
 *   · 名称/模块/仓库/技术栈是**项目组的身份**，由 PROJECT_SERIES 决定
 *   · 进展记录留在本地 state.json（GitHub 上没有对应物）
 * 这样也守住了「模型只翻译、落库只走白名单」这条线 —— AI 填充产生的计划
 * 落到 GitHub 时，只能改到这四个字段。
 */
const WRITABLE = {
  '进度':    { kind: 'number', get: (p) => Number(p.progress ?? 0) },
  'DDL':     { kind: 'date',   get: (p) => String(p.dueDate ?? '') },
  '推进状态': { kind: 'single', get: (p) => String(p.status ?? '') },
  '负责人':  { kind: 'text',   get: (p) => String(p.owner ?? '') },
}

/** 从仓库链接里取出仓名。 */
function repoFromLink(link) {
  const m = /github\.com\/[^/]+\/([^/?#]+)/.exec(String(link ?? ''))
  return m ? m[1] : ''
}

/** 设置看板字段值。 */
async function setBoardField({ fetchImpl, token, projectId, itemId, field, kind, value, fields }) {
  const f = fields[field]
  if (!f) return { ok: false, why: `Project 上没有字段「${field}」` }
  // 空值 = 清空该字段。写成空日期/空文本 GitHub 会忽略，
  // 必须用 clearProjectV2ItemFieldValue 才能真的清掉。
  if (value === '' || value === null || value === undefined) {
    const clear = `
mutation($pid: ID!, $iid: ID!, $fid: ID!) {
  clearProjectV2ItemFieldValue(input: {projectId: $pid, itemId: $iid, fieldId: $fid}) {
    projectV2Item { id }
  }
}`
    const res = await fetchImpl(GRAPHQL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: clear, variables: { pid: projectId, iid: itemId, fid: f.id } }),
    })
    const data = await res.json()
    if (data.errors?.length) return { ok: false, why: data.errors.map((e) => e.message).join('; ').slice(0, 200) }
    return { ok: true, cleared: true }
  }
  let val
  if (kind === 'single') {
    const oid = Object.entries(f.options ?? {}).find(([n]) => n === value)?.[1]
    if (!oid) return { ok: false, why: `字段「${field}」没有选项「${value}」` }
    val = { singleSelectOptionId: oid }
  } else if (kind === 'number') {
    val = { number: Number(value) || 0 }
  } else if (kind === 'date') {
    val = { date: String(value) }
  } else {
    val = { text: String(value) }
  }
  const mutation = `
mutation($pid: ID!, $iid: ID!, $fid: ID!, $val: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: {projectId: $pid, itemId: $iid, fieldId: $fid, value: $val}) {
    projectV2Item { id }
  }
}`
  const res = await fetchImpl(GRAPHQL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: mutation,
      variables: { pid: projectId, iid: itemId, fid: f.id, val },
    }),
  })
  const data = await res.json()
  if (data.errors?.length) return { ok: false, why: data.errors.map((e) => e.message).join('; ').slice(0, 200) }
  return { ok: true }
}

/** 改 issue 的开关状态（勾选待跟进 → 关闭 GitHub issue）。 */
async function setIssueState({ fetchImpl, token, owner, repo, number, state }) {
  const res = await fetchImpl(`${API}/repos/${owner}/${repo}/issues/${number}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ state }),
  })
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` }
  return { ok: true }
}

/** 新建一个项目组 Issue（显式新建才走这里，AI 填充同样要经用户确认）。 */
async function createGroupIssue({ fetchImpl, token, owner, repo, project, fields, projectId }) {
  const key = String(project.id).replace(/^group:/, '')
  const labels = ['type: group', `group:${key}`]
  const body = [
    project.summary ?? '',
    '',
    `- 分类：${project.module ?? ''}`,
    `- 主仓：${repo}`,
    `- 组内仓：${repo}`,
    `- 技术栈：${project.tags?.join(' · ') ?? ''}`,
    '',
    '<!-- 本 Issue 是该项目组在看板上的顶层条目；下面的子任务是组内各仓的具体工作项。 -->',
  ].join('\n')

  const created = await gh(fetchImpl, `${API}/repos/${owner}/${repo}/issues`, {
    token, method: 'POST',
    body: { title: project.name ?? key, body, labels },
  })

  // 取 node id 才能加进看板
  const query = `query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){id number}}}`
  const gq = await fetchImpl(GRAPHQL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables: { owner, repo, num: created.number } }),
  })
  const gdata = await gq.json()
  const nodeId = gdata.data?.repository?.issue?.id
  if (!nodeId) return { ok: false, why: '拿到 Issue 了但取不到 node id' }
  await gh(fetchImpl, GRAPHQL, {
    token, method: 'POST',
    body: {
      query: 'mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){projectV2Item{id}}}',
      variables: { p: projectId, c: nodeId },
    },
  })
  return { ok: true, number: created.number, nodeId }
}

/**
 * 把客户端提交的状态差异写回 GitHub。
 *
 * previous —— 上一次从 GitHub 读到的项目（真实远端状态）
 * next     —— 客户端提交的项目（用户在面板上改过的）
 *
 * 只做**确定性动作**：字段更新、勾选待跟进、显式新建项目。
 * 远端读失败时直接抛错，**不写任何东西** —— 否则一次网络抖动
 * 可能把客户端的整份列表当成"新建"推上去。
 */
export async function applyPortfolioChanges({
  fetchImpl = globalThis.fetch,
  token,
  owner,
  projectNumber = 1,
  previous = [],
  next = [],
} = {}) {
  if (!token) throw new Error('没有配置 GitHub 令牌')
  const { fields, byIssue } = await fetchProjectItems(fetchImpl, { token, owner, projectNumber })
  const projectId = await resolveProjectId({ fetchImpl, token, owner, projectNumber })
  if (!projectId) throw new Error(`取不到 Project #${projectNumber} 的节点 id`)
  const prevById = new Map(previous.map((p) => [p.id, p]))
  const summary = { updated: [], created: [], closedTasks: [], reopenedTasks: [], skipped: [] }

  for (const p of next) {
    const before = prevById.get(p.id)
    if (!before) {
      // 新项目：只有 id 形如 group:<key> 且带仓库链接才建；本地台账里的项目不进 GitHub
      if (!String(p.id ?? '').startsWith('group:')) {
        summary.skipped.push({ name: p.name, why: '不是 GitHub 项目组（仅存本地）' })
        continue
      }
      const repo = repoFromLink(p.link)
      if (!repo) {
        summary.skipped.push({ name: p.name, why: '没有仓库链接，无法定位主仓' })
        continue
      }
      const r = await createGroupIssue({ fetchImpl, token, owner, repo, project: p, fields, projectId })
      if (r.ok) summary.created.push({ name: p.name, repo, number: r.number })
      else summary.skipped.push({ name: p.name, why: r.why })
      continue
    }

    // 字段更新（白名单）
    const meta = before._meta ?? {}
    const board = byIssue[meta.nodeId]
    if (!board?.itemId) {
      summary.skipped.push({ name: p.name, why: '看板上找不到这个项目组的条目' })
      continue
    }
    for (const [field, spec] of Object.entries(WRITABLE)) {
      const bv = spec.get(before)
      const av = spec.get(p)
      if (String(bv) === String(av)) continue
      const r = await setBoardField({
        fetchImpl, token, projectId, itemId: board.itemId,
        field, kind: spec.kind, value: av, fields,
      })
      if (r.ok) summary.updated.push({ name: p.name, field, from: bv, to: av })
      else summary.skipped.push({ name: p.name, why: `${field}：${r.why}` })
    }

    // 待跟进勾选 → 关闭/重开 GitHub issue
    const doneBefore = new Map((before.todos ?? []).map((t) => [t.id, t.done === true]))
    for (const t of p.todos ?? []) {
      const was = doneBefore.get(t.id)
      if (was === undefined || was === (t.done === true)) continue
      const m = /^task:([^#]+)#(\d+)$/.exec(t.id)
      if (!m) continue                    // 本地待跟进，没有 GitHub 对应
      const r = await setIssueState({
        fetchImpl, token, owner, repo: m[1], number: Number(m[2]),
        state: t.done ? 'closed' : 'open',
      })
      if (r.ok) {
        const entry = { project: p.name, repo: m[1], number: Number(m[2]) }
        if (t.done) summary.closedTasks.push(entry)
        else summary.reopenedTasks.push(entry)
      } else {
        summary.skipped.push({ name: p.name, why: `待跟进 ${t.id}：${r.why}` })
      }
    }
  }
  return summary
}

export async function resolveProjectId({ fetchImpl = globalThis.fetch, token, owner, projectNumber = 1 } = {}) {
  const query = `query($login:String!,$num:Int!){repositoryOwner(login:$login){... on User{projectV2(number:$num){id}}}}`
  const res = await fetchImpl(GRAPHQL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { login: owner, num: projectNumber } }),
  })
  const data = await res.json()
  return data.data?.repositoryOwner?.projectV2?.id ?? ''
}
