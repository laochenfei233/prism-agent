/**
 * `sidebarGit` namespace dictionaries, and the namespace's declaration.
 *
 * The empty states name what the panel could not find — no git on the Host, no
 * repository at the working directory, no changes — because each one suggests
 * a different next step. The namespace merge lives with its key set so a
 * module naming `TranslateNS<'sidebarGit'>` needs only this file.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Git workbench type name, guide entry, sections, actions, and empty states. */
    sidebarGit: SidebarGitKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': '更改',
  'guide.title': '更改',
  'guide.description': '暂存并提交工作区的改动',
  refresh: '刷新仓库状态',
  'state.loading': '正在读取仓库…',
  'state.unavailable': '这个主机没有可用的 Git。',
  'state.notRepository': '当前工作区不是 Git 仓库。',
  'state.clean': '工作区干净，没有待提交的改动。',
  'state.failed': '无法读取仓库状态：{message}',
  'branch.detached': '游离 HEAD',
  'branch.ahead': '领先 {count}',
  'branch.behind': '落后 {count}',
  'section.staged': '已暂存',
  'section.unstaged': '未暂存',
  'section.untracked': '未跟踪',
  'row.stage': '暂存',
  'row.unstage': '取消暂存',
  'row.binary': '二进制文件，没有可预览的差异。',
  'row.untracked': '新文件，暂存后可以查看差异。',
  'diff.loading': '正在读取差异…',
  'diff.failed': '差异读取失败：{message}',
  'commit.placeholder': '提交信息',
  'commit.action': '提交',
  'commit.committing': '正在提交…',
  'commit.nothingStaged': '没有已暂存的改动。',
  commitRefused: '提交被拒绝：{message}',
} satisfies Record<string, string>

/** Git dictionary key union. */
export type SidebarGitKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Changes',
  'guide.title': 'Changes',
  'guide.description': 'Stage and commit this workspace\'s changes',
  refresh: 'Refresh repository status',
  'state.loading': 'Reading the repository…',
  'state.unavailable': 'Git is not available on this host.',
  'state.notRepository': 'This working directory is not a git repository.',
  'state.clean': 'The working tree is clean; nothing to commit.',
  'state.failed': 'Could not read the repository status: {message}',
  'branch.detached': 'Detached HEAD',
  'branch.ahead': '{count} ahead',
  'branch.behind': '{count} behind',
  'section.staged': 'Staged',
  'section.unstaged': 'Unstaged',
  'section.untracked': 'Untracked',
  'row.stage': 'Stage',
  'row.unstage': 'Unstage',
  'row.binary': 'Binary file; there is no diff to preview.',
  'row.untracked': 'New file; stage it to see its diff.',
  'diff.loading': 'Reading the diff…',
  'diff.failed': 'Could not read the diff: {message}',
  'commit.placeholder': 'Commit message',
  'commit.action': 'Commit',
  'commit.committing': 'Committing…',
  'commit.nothingStaged': 'Nothing is staged.',
  commitRefused: 'The commit was refused: {message}',
} satisfies Record<SidebarGitKey, string>
