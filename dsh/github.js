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
    if (f?.name) fields[f.name] = f
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
    byIssue[content.id] = { title: content.title, number: content.number, values }
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
    const todos = children.map((c) => ({
      id: `task:${repoName}#${c.number}`,
      title: c.title ?? '',
      owner: (c.assignee?.login ?? ''),
      dueDate: c.milestone?.due_on ? String(c.milestone.due_on).slice(0, 10) : '',
      done: c.state === 'closed',
      doneAt: c.closed_at ? String(c.closed_at).slice(0, 10) : '',
    }))

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
