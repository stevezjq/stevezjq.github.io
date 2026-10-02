/**
 * AI 搜索框（多工具 ReAct）
 * 依据「实验6-多工具+react.py」的逻辑改写为纯前端浏览器版本：
 *   - 主控模型：阿里云 DashScope qwen-flash
 *   - 工具：百度千帆 web_search、和风天气、qwen3-vl-flash 图像识别
 *   - 入口：导航栏搜索按钮旁的 AI 按钮
 *   - 头像：用户 = 博客头像；AI = 左下角看板娘头像
 *   - 对话记录：localStorage 持久化，可查看全部历史会话
 *
 * 依赖同目录的 ai-config.js（提供 window.AI_CONFIG，密钥为 Base64）。
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 固定配置（非密钥）
  // ---------------------------------------------------------------------------
  var LLM_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  var LLM_MODEL = 'qwen-flash';
  var VL_MODEL = 'qwen3-vl-flash';
  var WEB_SEARCH_URL = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
  var WEATHER_HOST = 'devapi.qweather.com';
  // 天气工具沿用 python 里写死的经纬度（北京 39.92,116.41）
  var WEATHER_LAT = 39.92;
  var WEATHER_LON = 116.41;

  var USER_AVATAR = 'https://b0.bdstatic.com/2609910f2091c0743d82fd09ff76c400.jpg';
  var AI_AVATAR = '/live2d-model2/c_0120/icon.png';

  var STORAGE_KEY = 'aiChatConversations_v1';
  var MAX_ROUNDS = 5;

  var SYSTEM_PROMPT =
    '你是博客网站的 AI 搜索助手，可以帮助读者搜索信息、查询天气、识别图片。' +
    '回答用简体中文，简洁清晰。需要最新信息或事实时优先调用工具，不要凭空编造。';

  // ---------------------------------------------------------------------------
  // 密钥解码
  // ---------------------------------------------------------------------------
  function decodeKey(b64) {
    if (!b64) return '';
    try {
      return atob(b64);
    } catch (e) {
      return '';
    }
  }

  function getCreds() {
    var c = window.AI_CONFIG || {};
    return {
      llm: decodeKey(c.llmKey),
      web: decodeKey(c.webSearchKey),
      weather: decodeKey(c.weatherKey)
    };
  }

  // ---------------------------------------------------------------------------
  // 工具定义（OpenAI/DashScope function calling 格式）
  // ---------------------------------------------------------------------------
  var TOOLS = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询指定城市的天气',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '需要查询天气的城市，例如北京、上海' }
          },
          required: ['city']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search',
        description: '搜索互联网，获取最新的网页信息',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '需要搜索的内容' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'image_recognition',
        description: '识别图片中的内容',
        parameters: {
          type: 'object',
          properties: {
            image_url: { type: 'string', description: '图片的URL' }
          },
          required: ['image_url']
        }
      }
    }
  ];

  // ---------------------------------------------------------------------------
  // 工具实现（浏览器 fetch 版本）
  // ---------------------------------------------------------------------------
  function toolSearch(query) {
    var creds = getCreds();
    return fetch(WEB_SEARCH_URL, {
      method: 'POST',
      headers: {
        'X-Appbuilder-Authorization': 'Bearer ' + creds.web,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: query }],
        search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: 10 }]
      })
    }).then(function (r) {
      return r.json().catch(function () { return { error: 'search parse failed', status_code: r.status }; });
    }).catch(function (err) {
      return { error: String(err) };
    });
  }

  function toolWeather(city) {
    var creds = getCreds();
    var url = 'https://' + WEATHER_HOST + '/weather/v1/current/' + WEATHER_LAT + '/' + WEATHER_LON;
    return fetch(url, {
      method: 'GET',
      headers: { 'X-QW-Api-Key': creds.weather }
    }).then(function (r) {
      return r.json().catch(function () { return { error: 'weather parse failed', status_code: r.status }; });
    }).catch(function (err) {
      return { error: String(err) };
    });
  }

  function toolImageRecognition(imageUrl) {
    var creds = getCreds();
    return fetch(LLM_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + creds.llm,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: VL_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: '识别图片中的内容' }
          ]
        }]
      })
    }).then(function (r) {
      return r.json();
    }).then(function (result) {
      try {
        return { description: result.choices[0].message.content };
      } catch (e) {
        return { error: JSON.stringify(result) };
      }
    }).catch(function (err) {
      return { error: String(err) };
    });
  }

  function callTool(name, args) {
    if (name === 'search') return toolSearch(args.query);
    if (name === 'get_weather') return toolWeather(args.city);
    if (name === 'image_recognition') return toolImageRecognition(args.image_url);
    return Promise.resolve({ error: '未知工具：' + name });
  }

  // ---------------------------------------------------------------------------
  // 调用主控模型（一次）
  // ---------------------------------------------------------------------------
  function callLLM(apiMessages) {
    var creds = getCreds();
    if (!creds.llm) {
      return Promise.reject(new Error('未检测到 AI 密钥配置（ai-config.js），请先按 ai-config.example.js 创建并填写密钥。'));
    }
    return fetch(LLM_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + creds.llm,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(apiMessages),
        tools: TOOLS
      })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error && (j.error.message || JSON.stringify(j.error))) || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  // 多轮 ReAct：支持「查天气→再搜索」等链式工具调用
  function runReAct(apiMessages, onStatus) {
    function step(round) {
      if (round >= MAX_ROUNDS) {
        return callLLM(apiMessages).then(function (result) {
          return extractContent(result);
        });
      }
      return callLLM(apiMessages).then(function (result) {
        var msg = result.choices[0].message;
        if (msg.tool_calls && msg.tool_calls.length) {
          apiMessages.push(msg);
          var chain = Promise.resolve();
          msg.tool_calls.forEach(function (tc) {
            chain = chain.then(function () {
              var fnName = tc.function.name;
              var fnArgs;
              try { fnArgs = JSON.parse(tc.function.arguments || '{}'); } catch (e) { fnArgs = {}; }
              if (onStatus) onStatus(statusTextFor(fnName, fnArgs));
              return callTool(fnName, fnArgs).then(function (toolResult) {
                apiMessages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: JSON.stringify(toolResult)
                });
              });
            });
          });
          return chain.then(function () { return step(round + 1); });
        }
        return msg.content || '';
      });
    }
    return step(0);
  }

  function extractContent(result) {
    var msg = result.choices[0].message;
    return msg.content || '';
  }

  function statusTextFor(name, args) {
    if (name === 'search') return '🔍 正在搜索：' + (args.query || '');
    if (name === 'get_weather') return '🌤 正在查询天气：' + (args.city || '');
    if (name === 'image_recognition') return '🖼 正在识别图片…';
    return '⚙ 正在调用工具…';
  }

  // ---------------------------------------------------------------------------
  // localStorage 会话存储
  // ---------------------------------------------------------------------------
  function loadStore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { activeId: null, conversations: [] };
      var data = JSON.parse(raw);
      if (!Array.isArray(data.conversations)) data.conversations = [];
      return data;
    } catch (e) {
      return { activeId: null, conversations: [] };
    }
  }

  function saveStore(store) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      /* 超出配额时静默失败 */
    }
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------------------------------------------------------------------------
  // 极简 Markdown 渲染（先转义再替换，避免 XSS）
  // ---------------------------------------------------------------------------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderMarkdown(text) {
    var esc = escapeHtml(text);
    // 代码块
    esc = esc.replace(/```([\s\S]*?)```/g, function (_, code) {
      return '<pre class="ai-code-block"><code>' + code.replace(/^\n/, '') + '</code></pre>';
    });
    // 行内代码
    esc = esc.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');
    // 加粗
    esc = esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // 链接 [text](url)
    esc = esc.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    // 换行
    esc = esc.replace(/\n/g, '<br>');
    return esc;
  }

  // ---------------------------------------------------------------------------
  // UI 构建
  // ---------------------------------------------------------------------------
  var els = {};
  var currentApiMessages = []; // 当前会话发送给 API 的完整上下文
  var isBusy = false;

  function buildUI() {
    var wrap = document.createElement('div');
    wrap.id = 'ai-search-wrap';
    wrap.innerHTML = [
      '<div id="ai-search-mask"></div>',
      '<div id="ai-search-dialog">',
      '  <div id="ai-search-sidebar">',
      '    <button id="ai-new-chat" type="button"><i class="fas fa-plus"></i> 新对话</button>',
      '    <div id="ai-history-title">历史对话</div>',
      '    <div id="ai-history-list"></div>',
      '  </div>',
      '  <div id="ai-search-main">',
      '    <div id="ai-search-header">',
      '      <span id="ai-search-title"><i class="fas fa-magic"></i> AI 工具</span>',
      '      <button id="ai-search-close" type="button" aria-label="关闭"><i class="fas fa-times"></i></button>',
      '    </div>',
      '    <div id="ai-messages"></div>',
      '    <div id="ai-input-area">',
      '      <textarea id="ai-input" rows="1" placeholder="问我任何问题，Enter 发送 / Shift+Enter 换行"></textarea>',
      '      <button id="ai-send" type="button" aria-label="发送"><i class="fas fa-paper-plane"></i></button>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('');
    document.body.appendChild(wrap);

    els.mask = document.getElementById('ai-search-mask');
    els.dialog = document.getElementById('ai-search-dialog');
    els.messages = document.getElementById('ai-messages');
    els.input = document.getElementById('ai-input');
    els.send = document.getElementById('ai-send');
    els.historyList = document.getElementById('ai-history-list');
    els.newChat = document.getElementById('ai-new-chat');

    document.getElementById('ai-search-close').addEventListener('click', closeAI);
    els.mask.addEventListener('click', closeAI);
    els.send.addEventListener('click', onSend);
    els.newChat.addEventListener('click', startNewChat);
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    });
    els.input.addEventListener('input', autoResize);
  }

  function autoResize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 140) + 'px';
  }

  function openAI() {
    els.dialog.classList.add('ai-open');
    els.mask.classList.add('ai-open');
    document.body.classList.add('ai-search-show');
    renderHistoryList();
    var store = loadStore();
    if (store.activeId) {
      var conv = store.conversations.find(function (c) { return c.id === store.activeId; });
      if (conv) { loadConversation(conv); return; }
    }
    if (!currentApiMessages.length) showWelcome();
    setTimeout(function () { els.input.focus(); }, 200);
  }

  function closeAI() {
    els.dialog.classList.remove('ai-open');
    els.mask.classList.remove('ai-open');
    document.body.classList.remove('ai-search-show');
  }

  function showWelcome() {
    els.messages.innerHTML =
      '<div class="ai-welcome"><img src="' + AI_AVATAR + '" alt="AI">' +
      '<p>你好呀！我是本站的 AI 搜索助手，可以帮你<b>联网搜索</b>、<b>查天气</b>、<b>识别图片</b>。</p>' +
      '<p>试着问我：「今天北京天气怎么样」或「搜索一下 Hexo 是什么」。</p></div>';
  }

  function clearMessagesDom() {
    els.messages.innerHTML = '';
  }

  function appendBubble(role, html) {
    var welcome = els.messages.querySelector('.ai-welcome');
    if (welcome) welcome.remove();
    var row = document.createElement('div');
    row.className = 'ai-msg ai-msg-' + role;
    var avatar = role === 'user' ? USER_AVATAR : AI_AVATAR;
    row.innerHTML =
      '<img class="ai-msg-avatar" src="' + avatar + '" alt="">' +
      '<div class="ai-msg-bubble">' + html + '</div>';
    els.messages.appendChild(row);
    els.messages.scrollTop = els.messages.scrollHeight;
    return row.querySelector('.ai-msg-bubble');
  }

  function renderHistoryList() {
    var store = loadStore();
    if (!store.conversations.length) {
      els.historyList.innerHTML = '<div class="ai-history-empty">暂无历史对话</div>';
      return;
    }
    els.historyList.innerHTML = '';
    store.conversations
      .slice()
      .sort(function (a, b) { return b.updatedAt - a.updatedAt; })
      .forEach(function (conv) {
        var item = document.createElement('div');
        item.className = 'ai-history-item' + (conv.id === store.activeId ? ' active' : '');
        var d = new Date(conv.updatedAt);
        item.innerHTML =
          '<span class="ai-history-item-title">' + escapeHtml(conv.title) + '</span>' +
          '<span class="ai-history-item-date">' + d.getMonth() + 1 + '/' + d.getDate() + '</span>' +
          '<button class="ai-history-del" title="删除"><i class="fas fa-trash"></i></button>';
        item.addEventListener('click', function (e) {
          if (e.target.closest('.ai-history-del')) {
            deleteConversation(conv.id);
            e.stopPropagation();
            return;
          }
          loadConversation(conv);
        });
        els.historyList.appendChild(item);
      });
  }

  function deleteConversation(id) {
    var store = loadStore();
    store.conversations = store.conversations.filter(function (c) { return c.id !== id; });
    if (store.activeId === id) {
      store.activeId = null;
      currentApiMessages = [];
      showWelcome();
    }
    saveStore(store);
    renderHistoryList();
  }

  function startNewChat() {
    var store = loadStore();
    store.activeId = null;
    saveStore(store);
    currentApiMessages = [];
    showWelcome();
    renderHistoryList();
    els.input.focus();
  }

  function loadConversation(conv) {
    currentApiMessages = JSON.parse(JSON.stringify(conv.apiMessages || []));
    clearMessagesDom();
    (conv.display || []).forEach(function (m) {
      appendBubble(m.role, renderMarkdown(m.content));
    });
    var store = loadStore();
    store.activeId = conv.id;
    saveStore(store);
    renderHistoryList();
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  // 持久化当前会话
  function persistConversation(displayMessages, apiMessages) {
    var store = loadStore();
    var title = (displayMessages.find(function (m) { return m.role === 'user'; }) || {}).content || '新对话';
    title = title.slice(0, 24);
    if (store.activeId) {
      var conv = store.conversations.find(function (c) { return c.id === store.activeId; });
      if (conv) {
        conv.display = displayMessages;
        conv.apiMessages = apiMessages;
        conv.updatedAt = Date.now();
        saveStore(store);
        renderHistoryList();
        return;
      }
    }
    var newConv = {
      id: uid(),
      title: title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      display: displayMessages,
      apiMessages: apiMessages
    };
    store.conversations.push(newConv);
    store.activeId = newConv.id;
    saveStore(store);
    renderHistoryList();
  }

  // 从 DOM 收集当前显示消息（user + assistant 文本）
  function collectDisplay() {
    var out = [];
    var rows = els.messages.querySelectorAll('.ai-msg');
    rows.forEach(function (row) {
      if (row.classList.contains('ai-msg-user')) {
        out.push({ role: 'user', content: row.querySelector('.ai-msg-bubble').textContent });
      } else if (row.classList.contains('ai-msg-assistant')) {
        var bubble = row.querySelector('.ai-msg-bubble');
        // 去掉临时状态提示节点
        var clone = bubble.cloneNode(true);
        var st = clone.querySelector('.ai-status');
        if (st) st.remove();
        out.push({ role: 'assistant', content: clone.textContent });
      }
    });
    return out;
  }

  function onSend() {
    if (isBusy) return;
    var text = els.input.value.trim();
    if (!text) return;

    els.input.value = '';
    autoResize();

    appendBubble('user', renderMarkdown(text));
    currentApiMessages.push({ role: 'user', content: text });

    var statusBubble = appendBubble('assistant', '<span class="ai-status">思考中…</span>');
    isBusy = true;
    els.send.disabled = true;

    runReAct(currentApiMessages, function (statusText) {
      statusBubble.innerHTML = '<span class="ai-status">' + escapeHtml(statusText) + '</span>';
      els.messages.scrollTop = els.messages.scrollHeight;
    }).then(function (answer) {
      statusBubble.innerHTML = renderMarkdown(answer || '（未获取到回答）');
      currentApiMessages.push({ role: 'assistant', content: answer || '' });
      persistConversation(collectDisplay(), currentApiMessages);
    }).catch(function (err) {
      statusBubble.innerHTML = '<span class="ai-error">⚠ ' + escapeHtml(err.message || String(err)) + '</span>';
    }).then(function () {
      isBusy = false;
      els.send.disabled = false;
      els.messages.scrollTop = els.messages.scrollHeight;
    });
  }

  // ---------------------------------------------------------------------------
  // 注入导航栏 AI 按钮
  // ---------------------------------------------------------------------------
  function injectNavButton() {
    if (document.getElementById('ai-nav-button')) return;

    var html =
      '<a class="site-page" href="javascript:void(0);">' +
      '<i class="fas fa-magic fa-fw"></i><span> AI工具</span></a>';

    // 优先作为一个 .menus_item 注入到 .menus_items 容器内部，
    // 这样能继承 Butterfly 菜单项的排版（inline-block，与其余按钮同排对齐）。
    var menusItems = document.querySelector('#menus .menus_items');
    if (menusItems) {
      var item = document.createElement('div');
      item.id = 'ai-nav-button';
      item.className = 'menus_item';
      item.innerHTML = html;
      item.addEventListener('click', openAI);
      menusItems.insertBefore(item, menusItems.firstChild);
      return;
    }

    // 兜底：若菜单容器尚未渲染，则挂在 #search-button 之后，并用 inline 排版避免断行。
    var searchBtn = document.getElementById('search-button');
    if (searchBtn && searchBtn.parentNode) {
      var aiBtn = document.createElement('span');
      aiBtn.id = 'ai-nav-button';
      aiBtn.style.display = 'inline';
      aiBtn.style.padding = '0 0 0 14px';
      aiBtn.innerHTML = html;
      aiBtn.addEventListener('click', openAI);
      searchBtn.parentNode.insertBefore(aiBtn, searchBtn.nextSibling);
    }
  }

  // ---------------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------------
  function init() {
    buildUI();
    injectNavButton();

    // 键盘 Esc 关闭
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && els.dialog && els.dialog.classList.contains('ai-open')) {
        closeAI();
      }
    });

    // Pjax / 动态导航栏重绘时重新注入按钮
    if (window.pjax) {
      document.addEventListener('pjax:complete', function () {
        injectNavButton();
      });
    }
    // 监听 DOM 变化以适配 butterfly 菜单异步渲染
    var tries = 0;
    var timer = setInterval(function () {
      injectNavButton();
      if (++tries > 10 || document.getElementById('ai-nav-button')) clearInterval(timer);
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
