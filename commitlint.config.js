// commitlint 配置：强制提交信息遵循 Conventional Commits。
// 由 simple-git-hooks 的 commit-msg hook 调用（见 package.json）。
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 允许中文提交描述，放宽正文/描述的大小写与长度限制以适配中文场景。
    'subject-case': [0],
    'subject-full-stop': [0],
    'header-max-length': [2, 'always', 100],
  },
};
