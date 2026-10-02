// AI 搜索框密钥配置模板
// 使用方法：复制本文件为同目录下的 ai-config.js，填入你自己的 Base64 编码密钥。
// ai-config.js 已在 .gitignore 中，不会被提交到仓库。
// 生成 Base64：在 PowerShell 中执行
//   [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("你的明文key"))
window.AI_CONFIG = {
  // 阿里云 DashScope（通义千问）API Key，形如 sk-xxxx
  llmKey: 'PASTE_BASE64_LLM_KEY_HERE',
  // 百度千帆 AI 搜索（web_search）API Key，形如 bce-v3/xxxx
  webSearchKey: 'PASTE_BASE64_WEBSEARCH_KEY_HERE',
  // 和风天气 API Key
  weatherKey: 'PASTE_BASE64_WEATHER_KEY_HERE'
};
