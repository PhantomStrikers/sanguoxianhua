
/**
 * 小程序：三国咸话
 * 变量名：SGS_TOKENS
 * 变量值：格式为 备注+++token+++clientId
 * 示例（使用您抓包中的数据）：
 * SGS_TOKENS="我的账号+++eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...+++f6ec8ffe...021af8c6886"
 */

const axios = require('axios');

// 通知模块（兼容 sendNotify/notify）
let notify = {};
try { notify = require('./sendNotify'); } catch (e) {
  try { notify = require('./notify'); } catch (e2) { console.log('未找到推送模块'); }
}

// ========= 配置 =========
const ENV_NAME = 'SGS_TOKENS';
const DEFAULT_CLIENT_ID = 'f6ec8ffe-3f4c-43e1-8d24-9021af8c6886';

const CONFIG = {
  APP_NAME: '三国杀',
  BASE_URL: 'https://api-xh.sanguosha.cn',
  FORUM_URL: 'https://wxforum.sanguosha.cn',
  APP_ID: 'wxd67100c9bcf72279',
  APP_VERSION: '7.2.0',
  APP_CODE: '2',
  GAME_ID: '2',

  TASK_STATUS: { NOT_STARTED: -1, IN_PROGRESS: 0, COMPLETED: 1, REWARD_CLAIMED: 2 },

  EFFECTIVE_PARAMS: {
    VIEW_TASK: { channelId: 2, operationType: 1, operateType: 1 },
    SHARE_TASK: { operateType: 2 }
  },

  KEY_TASKS: { LIKE_10: 1001, VIEW_3: 1003, SHARE_1: 1004 },

  REQUEST_TIMEOUT: 20000,
  REQUEST_INTERVAL: 2000,
  ACCOUNT_INTERVAL: 3000,

  // 重试策略
  MAX_RETRIES: 3,
  RETRY_BASE_DELAY: 800 // ms
};

let allResults = [];

// ========= 日志 =========
function now() { return new Date().toISOString().replace('T', ' ').split('.')[0]; }
function log(type, message, accountName = '系统') {
  const prefix = { info: '[INFO]', success: '[SUCCESS]', warning: '[WARNING]', error: '[ERROR]' }[type] || '[INFO]';
  const line = `${prefix} ${now()} ${accountName} - ${message}`;
  console.log(line);
  allResults.push(line);
}

// ========= 工具：重试与等待 =========
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function retryable(fn, opts = {}) {
  const retries = opts.retries ?? CONFIG.MAX_RETRIES;
  const baseDelay = opts.baseDelay ?? CONFIG.RETRY_BASE_DELAY;
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
}

// ========= 账号管理 =========
function getAccountsFromEnv() {
  const envValue = (process.env[ENV_NAME] || '').trim();
  if (!envValue) {
    log('error', `请配置环境变量 ${ENV_NAME}`);
    log('info', `格式: 备注+++token+++clientId`);
    process.exit(1);
  }
  const lines = envValue.split('\n').map(l => l.trim()).filter(Boolean);
  const accounts = lines.map(line => {
    const parts = line.split('+++');
    return {
      name: parts[0] || '未知账号',
      token: parts[1] || '',
      clientId: parts[2] || DEFAULT_CLIENT_ID
    };
  }).filter(a => a.token);
  if (accounts.length === 0) { log('error', '未找到有效账号配置'); process.exit(1); }
  log('success', `共读取到 ${accounts.length} 个账号`);
  return accounts;
}

// ========= 请求实例生成 =========
function createRequestInstance(account) {
  const commonHeaders = {
    'Authorization': `Bearer ${account.token}`,
    'AppVersion-Code': '720',
    'xweb_xhr': '1',
    'App-System': 'weixin',
    'client-Id': account.clientId,
    'App-Version': CONFIG.APP_VERSION,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Content-Type': 'application/json',
    'platform': 'weixin',
    'Accept': '*/*',
    'Referer': `https://servicewechat.com/${CONFIG.APP_ID}/636/page-frame.html`,
    'Accept-Language': 'zh-CN,zh;q=0.9'
  };

  const apiXh = axios.create({
    baseURL: CONFIG.BASE_URL,
    timeout: CONFIG.REQUEST_TIMEOUT,
    headers: { ...commonHeaders, 'App-Code': CONFIG.APP_CODE }
  });

  const forum = axios.create({
    baseURL: CONFIG.FORUM_URL,
    timeout: CONFIG.REQUEST_TIMEOUT,
    headers: commonHeaders
  });

  // 简单拦截器：把非 2xx 当作错误抛出（方便 retry）
  [apiXh, forum].forEach(inst => {
    inst.interceptors.response.use(
      r => r,
      e => { throw (e.response ? new Error(JSON.stringify({ status: e.response.status, data: e.response.data })) : e); }
    );
  });

  return { apiXh, forum };
}

// ========= 公共请求封装 =========
async function requestWithRetry(inst, method, url, data = null, opts = {}) {
  return retryable(async () => {
    const config = { url, method, timeout: CONFIG.REQUEST_TIMEOUT };
    if (method.toLowerCase() === 'get') config.params = data;
    else config.data = data;
    const res = await inst.request(config);
    return res;
  }, opts);
}

// ========= 签到与用户信息 =========
async function getUserInfo(forumInstance, account) {
  try {
    log('info', '获取用户信息...', account.name);
    const res = await requestWithRetry(forumInstance, 'get', '/api/profile');
    if (res.data && res.data.code === 0) {
      const user = res.data.data || {};
      log('success', `用户: ${user.nick_name || '-'}, 豆子: ${user.coin ?? 0}`, account.name);
      return user;
    }
    throw new Error(res.data?.msg || '未知响应');
  } catch (err) {
    log('warning', `获取用户信息失败: ${err.message}`, account.name);
    return null;
  }
}

async function doSignIn(forumInstance, account) {
  try {
    log('info', '执行签到...', account.name);
    const res = await requestWithRetry(forumInstance, 'post', '/api/user/signIn', {});
    if (res.data && res.data.code === 0) {
      const reward = res.data.data?.num || 0;
      log('success', `签到成功，获得 ${reward} 豆子`, account.name);
      return { success: true, reward };
    }
    log('info', `签到未成功: ${res.data?.msg || '未知原因'}`, account.name);
    return { success: false, message: res.data?.msg || '签到未成功' };
  } catch (err) {
    log('warning', `签到异常: ${err.message}`, account.name);
    return { success: false, message: err.message };
  }
}

// ========= 核心 API =========
async function getTaskList(apiXhInstance, account) {
  try {
    log('info', '获取任务列表...', account.name);
    const res = await requestWithRetry(apiXhInstance, 'get', '/task/sgxh-task/taskList');
    if (res.data && (res.data.code === 1000 || res.data.code === 0)) {
      return res.data.data || [];
    }
    log('warning', `获取任务列表异常: ${res.data?.message || JSON.stringify(res.data)}`, account.name);
    return [];
  } catch (err) {
    log('warning', `获取任务列表失败: ${err.message}`, account.name);
    return [];
  }
}

async function getHotPosts(apiXhInstance, account, limit = 10) {
  try {
    log('info', '获取热帖列表...', account.name);
    const res = await requestWithRetry(apiXhInstance, 'get', `/postings/hotList`, { gameId: CONFIG.GAME_ID });
    if (res.data && (res.data.code === 1000 || res.data.code === 0)) {
      const posts = res.data.data || [];
      const ids = posts.slice(0, limit).map(p => p.id || p.postId).filter(Boolean);
      log('success', `获取到 ${ids.length} 个帖子ID`, account.name);
      return ids;
    }
    log('warning', `获取热帖失败: ${res.data?.message || JSON.stringify(res.data)}`, account.name);
    return [];
  } catch (err) {
    log('warning', `获取热帖异常: ${err.message}`, account.name);
    return [];
  }
}

async function getPostDetail(forumInstance, account, postId) {
  try {
    const res = await requestWithRetry(forumInstance, 'get', `/api/topics/${postId}`, { include: 'user,label' });
    return res.data && res.data.code === 0 ? res.data : null;
  } catch (_) {
    return null;
  }
}

async function doLikePost(apiXhInstance, account, postId) {
  try {
    const res = await requestWithRetry(apiXhInstance, 'post', '/postings/sgxh/post/upvote', { postId, isUpvote: 1 });
    return { success: res.data?.code === 1000, message: res.data?.message };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function updateViewTaskProgress(apiXhInstance, account, postId) {
  try {
    // 优先调用两个接口组合
    const res1 = await requestWithRetry(apiXhInstance, 'post', '/user/act-user-task/updateTaskProgress', {
      channelId: CONFIG.EFFECTIVE_PARAMS.VIEW_TASK.channelId,
      postId,
      operationType: CONFIG.EFFECTIVE_PARAMS.VIEW_TASK.operationType,
      gameId: CONFIG.GAME_ID
    });

    await sleep(600);
    const res2 = await requestWithRetry(apiXhInstance, 'post', '/task/sgxh-task/updateTaskProgress', {
      operateType: CONFIG.EFFECTIVE_PARAMS.VIEW_TASK.operateType,
      gameId: CONFIG.GAME_ID
    });

    const ok = (res1.data && res1.data.code === 1000) || (res2.data && res2.data.code === 1000);
    return { success: ok, method1: res1.data, method2: res2.data };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ========= 任务分析与执行 =========
function analyzeTasks(tasks = []) {
  const result = { daily: [], byId: {}, completed: 0, total: tasks.length };
  tasks.forEach(t => {
    const taskInfo = {
      id: t.taskId,
      desc: t.taskDesc,
      type: t.taskType,
      progress: t.currentProgressValue ?? 0,
      target: t.targetProgressValue ?? 0,
      status: t.progressStatus ?? CONFIG.TASK_STATUS.NOT_STARTED,
      rewards: t.rewardInfos || [],
      taskProgressId: t.taskProgressId,
      canClaim: (t.progressStatus === CONFIG.TASK_STATUS.COMPLETED) && Boolean(t.taskProgressId)
    };
    result.byId[taskInfo.id] = taskInfo;
    if (taskInfo.type === 1) result.daily.push(taskInfo);
    if ((t.progressStatus ?? -1) >= CONFIG.TASK_STATUS.COMPLETED) result.completed++;
  });
  return result;
}

function getNeedExecuteCount(taskInfo) {
  if (!taskInfo) return 0;
  if (taskInfo.status >= CONFIG.TASK_STATUS.COMPLETED) return 0;
  return Math.max(0, (taskInfo.target || 0) - (taskInfo.progress || 0));
}

async function executeLikeTask(apiXhInstance, forumInstance, account, taskInfo, postIds = []) {
  const results = [];
  const need = getNeedExecuteCount(taskInfo);
  const max = Math.min(need, 10, postIds.length);
  if (max <= 0) return results;
  log('info', `执行点赞任务，需要点赞 ${max} 次`, account.name);

  for (let i = 0; i < max; i++) {
    const postId = postIds[i];
    try {
      await getPostDetail(forumInstance, account, postId);
      await sleep(800);
      const like = await doLikePost(apiXhInstance, account, postId);
      if (like.success) {
        results.push(`✅ 点赞 ${postId}`);
        await updateViewTaskProgress(apiXhInstance, account, postId).catch(() => {});
      } else {
        results.push(`❌ 点赞 ${postId} 失败: ${like.message || '未知'}`);
      }
    } catch (err) {
      results.push(`❌ 点赞 ${postId} 异常`);
    }
    await sleep(CONFIG.REQUEST_INTERVAL);
  }
  return results;
}

async function executeViewTask(apiXhInstance, forumInstance, account, taskInfo, postIds = [], startIndex = 0) {
  const results = [];
  const need = getNeedExecuteCount(taskInfo);
  if (need <= 0) return results;
  log('info', `执行浏览任务，需要浏览 ${need} 次`, account.name);

  for (let i = 0; i < need; i++) {
    if (!postIds.length) break;
    const idx = (startIndex + i) % postIds.length;
    const postId = postIds[idx];
    try {
      await getPostDetail(forumInstance, account, postId);
      await sleep(1200);
      const r = await updateViewTaskProgress(apiXhInstance, account, postId);
      if (r.success) {
        results.push(`✅ 浏览 ${postId} 成功`);
        await sleep(800);
        await getPostDetail(forumInstance, account, postId);
      } else {
        results.push(`❌ 浏览 ${postId} 失败`);
      }
    } catch (err) {
      results.push(`❌ 浏览 ${postId} 异常`);
    }
    await sleep(CONFIG.REQUEST_INTERVAL * 2);
  }

  // 检查最新进度
  await sleep(1500);
  const tasks = await getTaskList(apiXhInstance, account);
  const analysis = analyzeTasks(tasks);
  const viewTask = analysis.byId[CONFIG.KEY_TASKS.VIEW_3];
  if (viewTask) log('info', `浏览任务进度: ${viewTask.progress}/${viewTask.target}`, account.name);
  return results;
}

async function executeShareTask(apiXhInstance, account, taskInfo) {
  const results = [];
  const need = getNeedExecuteCount(taskInfo);
  if (need <= 0) return results;
  log('info', `执行分享任务，需要分享 ${need} 次`, account.name);
  for (let i = 0; i < need; i++) {
    try {
      const res = await requestWithRetry(apiXhInstance, 'post', '/task/sgxh-task/updateTaskProgress', {
        operateType: CONFIG.EFFECTIVE_PARAMS.SHARE_TASK.operateType,
        gameId: CONFIG.GAME_ID
      });
      if (res.data?.code === 1000) results.push('✅ 分享成功');
      else results.push(`❌ 分享失败: ${res.data?.message || JSON.stringify(res.data)}`);
    } catch (err) {
      results.push(`❌ 分享异常: ${err.message}`);
    }
    await sleep(CONFIG.REQUEST_INTERVAL);
  }
  return results;
}

async function claimAllRewards(apiXhInstance, account, tasks = []) {
  const results = [];
  let claimed = 0;
  for (const t of tasks) {
    if (!t || !t.canClaim || !t.taskProgressId) continue;
    try {
      const res = await requestWithRetry(apiXhInstance, 'post', '/task/sgxh-task/getReward', { taskProgressId: t.taskProgressId });
      if (res.data?.code === 1000) { results.push(`✅ 任务 ${t.id} 奖励领取成功`); claimed++; }
      else if (res.data?.code === 4003) results.push(`ℹ️ 任务 ${t.id} 奖励已领取`);
      else results.push(`❌ 任务 ${t.id} 奖励领取失败: ${res.data?.message || JSON.stringify(res.data)}`);
    } catch (err) {
      results.push(`❌ 任务 ${t.id} 奖励领取异常: ${err.message}`);
    }
    await sleep(CONFIG.REQUEST_INTERVAL);
  }
  return { results, claimed };
}

// ========= 单账号处理主流程 =========
async function processAccount(account) {
  const result = { name: account.name, signIn: { success: false, reward: 0 }, userInfo: null, tasks: { total: 0, completed: 0 }, dailyResults: [], rewards: { claimed: 0 } };
  log('info', `\n======= 处理账号: ${account.name} =======`, account.name);
  try {
    const { apiXh, forum } = createRequestInstance(account);
    // 用户信息
    result.userInfo = await getUserInfo(forum, account);
    await sleep(400);
    // 签到
    result.signIn = await doSignIn(forum, account);
    await sleep(400);
    // 任务列表
    const tasks = await getTaskList(apiXh, account);
    const taskAnalysis = analyzeTasks(tasks);
    result.tasks = { total: taskAnalysis.total, completed: taskAnalysis.completed };
    log('info', `任务完成情况: ${taskAnalysis.completed}/${taskAnalysis.total}`, account.name);
    // 获取热帖
    const postIds = await getHotPosts(apiXh, account, 15);
    if (postIds.length < 5) {
      log('warning', '帖子数量不足，跳过部分任务', account.name);
    }
    // 每日任务执行
    const likeTask = taskAnalysis.byId[CONFIG.KEY_TASKS.LIKE_10];
    const viewTask = taskAnalysis.byId[CONFIG.KEY_TASKS.VIEW_3];
    const shareTask = taskAnalysis.byId[CONFIG.KEY_TASKS.SHARE_1];

    if (likeTask && postIds.length) {
      result.dailyResults.push(...await executeLikeTask(apiXh, forum, account, likeTask, postIds));
    }
    if (viewTask && postIds.length) {
      result.dailyResults.push(...await executeViewTask(apiXh, forum, account, viewTask, postIds, 10));
    }
    if (shareTask) {
      result.dailyResults.push(...await executeShareTask(apiXh, account, shareTask));
    }

    // 领奖
    await sleep(1000);
    const updated = analyzeTasks(await getTaskList(apiXh, account));
    const rewardResults = await claimAllRewards(apiXh, account, updated.daily);
    result.rewards.claimed = rewardResults.claimed;
    log('success', `处理完成，签到${result.signIn.success ? '成功' : '失败'}, 领取 ${rewardResults.claimed} 个奖励`, account.name);
  } catch (err) {
    log('error', `处理失败: ${err.message}`, account.name);
  }
  return result;
}

// ========= 汇总与通知 =========
function generateSummary(results) {
  let summary = `📊 三国杀任务执行汇总（修复版 + 签到功能）\n\n`;
  let totalSignSuccess = 0;
  results.forEach((r, i) => {
    summary += `👤 账号 ${i + 1}: ${r.name}\n`;
    summary += `  签到: ${r.signIn.success ? `✅ 成功 (+${r.signIn.reward}豆)` : `❌ 失败`}\n`;
    summary += `  任务完成: ${r.tasks.completed}/${r.tasks.total}\n`;
    summary += `  领取奖励: ${r.rewards.claimed} 个\n`;
    const successCount = (r.dailyResults || []).filter(x => x.includes('✅')).length;
    summary += `  每日任务成功: ${successCount} 次\n\n`;
    if (r.signIn.success) totalSignSuccess++;
  });
  summary += `📈 总体统计:\n  签到成功: ${totalSignSuccess}/${results.length} 个账号\n`;
  summary += `⏰ 执行时间: ${new Date().toLocaleString('zh-CN')}`;
  return summary;
}

async function sendNotification(summary) {
  const title = `三国杀任务执行结果（修复版 + 签到功能）`;
  if (typeof notify.sendNotify === 'function') {
    try { await notify.sendNotify(title, summary); return; } catch (err) { /* fallback to console */ }
  }
  console.log(`\n${title}\n${summary}`);
}

// ========= 主入口 =========
async function main() {
  log('info', '🚀 三国杀任务开始执行（优化版 + 签到功能）');
  const accounts = getAccountsFromEnv();
  const accountResults = [];
  for (let i = 0; i < accounts.length; i++) {
    const res = await processAccount(accounts[i]);
    accountResults.push(res);
    if (i < accounts.length - 1) await sleep(CONFIG.ACCOUNT_INTERVAL);
  }
  const summary = generateSummary(accountResults);
  await sendNotification(summary);
  log('success', '🎉 所有账号处理完成');
}

if (require.main === module) {
  main().catch(e => { console.error('❌ 脚本执行失败:', e); process.exit(1); });
}

module.exports = { main };
