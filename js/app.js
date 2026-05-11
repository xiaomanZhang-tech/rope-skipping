/* ============================================
   爱上跳绳APP - 核心逻辑
   AI骨骼识别 + 一分钟跳绳计数
   ============================================ */

// ============ 全局状态 ============
const STATE = {
  // 导航
  currentPage: 'home',

  // 相机
  cameraStream: null,
  cameraReady: false,
  usingFrontCamera: true,

  // AI 检测
  detector: null,
  modelLoading: false,
  detectionRunning: false,

  // 运动
  exerciseActive: false,
  isPaused: false,
  timeRemaining: 60,
  jumpCount: 0,
  timerInterval: null,
  detectionInterval: null,

  // 跳数检测
  isJumping: false,
  jumpCooldown: 0,
  recentAnkleY: [],
  prevFrameData: null,    // 备用方案的上一帧数据
  motionMode: false,      // 是否使用无AI运动检测
  modelLoadAttempted: false,
  dbgShow: true,           // 调试面板

  // 音频
  speechSynth: window.speechSynthesis,
  soundEnabled: true,

  // 数据
  history: [],
  currentResult: null
};

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', () => {
  loadHistory();
  preloadDetector();
});

// ============ 页面导航 ============
function navigateTo(page) {
  // 如果从运动中退出
  if (STATE.currentPage === 'exercise' && page !== 'exercise') {
    if (STATE.exerciseActive) {
      showConfirm('确定要退出吗？本次成绩将不保存', () => {
        stopExercise();
        switchPage(page);
      });
      return;
    }
    stopExercise();
  }

  switchPage(page);
}

function switchPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  STATE.currentPage = page;

  if (page === 'prepare') initPreparePage();
  if (page === 'history') renderHistory();
}

// ============ 首页 ============
// 纯 HTML 展示

// ============ 准备界面 ============
async function initPreparePage() {
  const btn = document.getElementById('btn-start');
  const permissionPrompt = document.getElementById('permission-prompt');

  btn.disabled = true;
  document.getElementById('btn-start-text').textContent = '加载模型中...';

  // 检查模型是否已加载
  if (!STATE.detector) {
    await preloadDetector();
  }

  permissionPrompt.classList.add('hidden');

  // 尝试开启相机
  try {
    await startCamera('prepare');
    btn.disabled = false;
    document.getElementById('btn-start-text').textContent = '开始跳绳';
    document.getElementById('camera-placeholder').classList.add('hidden');
  } catch (err) {
    console.error('Camera error:', err);
    permissionPrompt.classList.remove('hidden');
    btn.disabled = true;
    document.getElementById('btn-start-text').textContent = '需要相机权限';
  }
}

// ============ 相机管理 ============
async function startCamera(target) {
  const videoId = target === 'prepare' ? 'video' : 'exercise-video';

  // 如果已有流，先停止
  if (STATE.cameraStream) {
    STATE.cameraStream.getTracks().forEach(t => t.stop());
  }

  const constraints = {
    video: {
      facingMode: STATE.usingFrontCamera ? 'user' : 'environment',
      width: { ideal: 480 },
      height: { ideal: 360 }
    },
    audio: false
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  STATE.cameraStream = stream;
  STATE.cameraReady = true;

  const videoEl = document.getElementById(videoId);
  videoEl.srcObject = stream;

  return new Promise((resolve) => {
    videoEl.onloadedmetadata = () => {
      videoEl.play();
      resolve();
    };
  });
}

function stopCamera() {
  if (STATE.cameraStream) {
    STATE.cameraStream.getTracks().forEach(t => t.stop());
    STATE.cameraStream = null;
  }
  STATE.cameraReady = false;
}

function requestCamera() {
  startCamera('prepare').then(() => {
    document.getElementById('permission-prompt').classList.add('hidden');
    const btn = document.getElementById('btn-start');
    btn.disabled = false;
    document.getElementById('btn-start-text').textContent = '开始跳绳';
    document.getElementById('camera-placeholder').classList.add('hidden');
  }).catch(() => {
    showModal('权限提示', '无法获取相机权限，请在系统设置中允许相机访问');
  });
}

// ============ AI 模型加载 ============
async function preloadDetector() {
  if (STATE.detector || STATE.modelLoading) return;
  STATE.modelLoading = true;

  try {
    // 使用 MoveNet 模型 - 单姿态检测，闪电版（适合移动端）
    const detectorConfig = {
      modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING
    };
    STATE.detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      detectorConfig
    );
    console.log('MoveNet 模型加载完成');
  } catch (err) {
    console.error('模型加载失败:', err);
    STATE.detector = null;
  }

  STATE.modelLoading = false;
  STATE.modelLoadAttempted = true;
}

// ============ 运动核心逻辑 ============
async function startExercise() {
  // 切换到运动界面
  switchPage('exercise');

  // 重置状态
  STATE.exerciseActive = true;
  STATE.isPaused = false;
  STATE.timeRemaining = 60;
  STATE.jumpCount = 0;
  STATE.ankleBaseline = null;
  STATE.isJumping = false;
  STATE.landedSinceJump = false;
  STATE.jumpCooldown = 0;
  STATE.recentAnkleY = [];

  // UI 重置
  document.getElementById('timer-display').textContent = '60';
  document.getElementById('timer-display').classList.remove('warning');
  document.getElementById('count-display').textContent = '0';
  document.getElementById('exercise-status').textContent = '3...';
  document.getElementById('btn-pause').classList.remove('hidden');
  document.getElementById('btn-restart').classList.add('hidden');
  document.getElementById('btn-resume').classList.add('hidden');

  // 启动相机 (运动界面)
  try {
    await startCamera('exercise');
  } catch (err) {
    showModal('相机错误', '无法启动相机，请检查权限设置');
    navigateTo('prepare');
    return;
  }

  // 启动检测
  startDetection();

  // 显示调试面板
  const dp = document.getElementById('dbg-panel');
  if (dp) dp.style.display = 'flex';

  // 3-2-1 倒计时
  await countdown321();

  // 开始正式计时
  document.getElementById('exercise-status').textContent = '开始！';
  startTimer();
}

function countdown321() {
  return new Promise(resolve => {
    let count = 3;
    const el = document.getElementById('exercise-status');

    const tick = () => {
      if (count > 0) {
        el.textContent = count + '...';
        speakNumber(count);
        count--;
        setTimeout(tick, 800);
      } else {
        el.textContent = '开始！';
        resolve();
      }
    };
    tick();
  });
}

// ============ 计时器 ============
function startTimer() {
  if (STATE.timerInterval) clearInterval(STATE.timerInterval);

  STATE.timerInterval = setInterval(() => {
    if (STATE.isPaused) return;

    STATE.timeRemaining--;

    // 更新显示
    const display = document.getElementById('timer-display');
    display.textContent = STATE.timeRemaining;

    // 最后10秒警告
    if (STATE.timeRemaining <= 10) {
      display.classList.add('warning');
      // 语音提示
      if (STATE.timeRemaining <= 5 && STATE.timeRemaining > 0) {
        speakNumber(STATE.timeRemaining);
      }
    }

    if (STATE.timeRemaining === 10) {
      speak('还有10秒');
    }

    // 时间到
    if (STATE.timeRemaining <= 0) {
      clearInterval(STATE.timerInterval);
      STATE.timerInterval = null;
      speak('时间到');
      endExercise();
    }
  }, 1000);
}

// ============ 跳跃检测（降频优化版）============
// AI推理每120ms跑一次，骨骼绘制每240ms刷新一次
// 运动检测复用离线画布，不再每帧创建新对象
let _frameCount = 0;
let _motionCanvas = null;

function startDetection() {
  if (STATE.detectionInterval) return;
  STATE.detectionRunning = true;
  _frameCount = 0;

  // 如果模型没加载成功，启用无AI的运动检测备用方案
  if (!STATE.detector && STATE.modelLoadAttempted) {
    STATE.motionMode = true;
    updateDebug('mdl', '帧差');
  }

  // 运动检测复用画布（只创建一次）
  _motionCanvas = _motionCanvas || document.createElement('canvas');

  // AI推理节流：最小间隔120ms
  let lastAiTime = 0;
  const AI_INTERVAL = 120; // ms
  let drawSkip = 0;

  const detectFrame = async (now) => {
    if (!STATE.detectionRunning) return;

    const videoEl = document.getElementById('exercise-video');
    if (!videoEl || !videoEl.readyState) {
      STATE.detectionInterval = requestAnimationFrame(detectFrame);
      return;
    }

    _frameCount++;

    if (!STATE.motionMode && STATE.detector) {
      // === AI模式：降频推理 ===
      if (now - lastAiTime >= AI_INTERVAL) {
        lastAiTime = now;
        try {
          const poses = await STATE.detector.estimatePoses(videoEl, {
            flipHorizontal: STATE.usingFrontCamera
          });
          drawSkip++;
          if (poses && poses.length > 0) {
            const kp = poses[0].keypoints;
            if (drawSkip % 2 === 0) drawPose(document.getElementById('exercise-canvas'), kp, videoEl.videoWidth, videoEl.videoHeight);
            processJumpPose(kp, videoEl.videoHeight);
          } else {
            document.getElementById('exercise-status').textContent = '⚠ 未检测到人体';
          }
        } catch (_) {}
      }
    } else {
      // === 备用方案：帧差运动检测（也降频到1/3帧） ===
      if (_frameCount % 3 === 0) {
        detectMotionFallback(videoEl);
      }
    }

    if (STATE.exerciseActive) {
      STATE.detectionInterval = requestAnimationFrame(detectFrame);
    }
  };

  STATE.detectionInterval = requestAnimationFrame(detectFrame);
}

function stopDetection() {
  STATE.detectionRunning = false;
  if (STATE.detectionInterval) {
    cancelAnimationFrame(STATE.detectionInterval);
    STATE.detectionInterval = null;
  }
  const canvas = document.getElementById('exercise-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// ============ 跳跃计数算法 (AI骨骼模式) ============
// 原理：追踪脚踝Y坐标，用最近N帧中的最大值作为"地面"参考。
// 跳起时脚踝在画面中上移（Y减小），lift = groundY - currentAnkleY 为正值。
// 落地后回到地面，lift ≈ 0。
// 连续跳跃时，只要窗口中有至少1帧地面数据，maxY就能正确反映地面位置。
function processJumpPose(keypoints, frameHeight) {
  if (STATE.isPaused || !STATE.exerciseActive) return;

  // 获取脚踝 (15=左脚踝, 16=右脚踝)
  // 降低置信度阈值到0.2，支持远距离低分辨率识别
  const CONF = 0.2;
  const leftAnkle = keypoints[15];
  const rightAnkle = keypoints[16];
  const validAnkles = [];
  if (leftAnkle.score > CONF) validAnkles.push(leftAnkle);
  if (rightAnkle.score > CONF) validAnkles.push(rightAnkle);
  if (validAnkles.length === 0) {
    document.getElementById('exercise-status').textContent = '未检测到人体';
    return;
  }
  document.getElementById('exercise-status').textContent = '✓ 识别正常';

  const avgAnkleY = validAnkles.reduce((s, a) => s + a.y, 0) / validAnkles.length;

  // === 计算身体高度（自适应阈值基准） ===
  // 远距离时人物在画面中较小，用画面高度的一半做兜底
  const nose = keypoints[0];
  let bodyHeight = frameHeight * 0.55;
  if (nose && nose.score > CONF) {
    bodyHeight = avgAnkleY - nose.y;
  } else {
    const ls = keypoints[5], rs = keypoints[6];
    if (ls.score > CONF && rs.score > CONF) {
      bodyHeight = avgAnkleY - (ls.y + rs.y) / 2;
    }
  }
  // 如果身体高度异常小（远距离），用画面高度的比例兜底
  if (bodyHeight < frameHeight * 0.12) bodyHeight = frameHeight * 0.55;

  // === 滑动窗口 + 最大值基线 ===
  STATE.recentAnkleY.push(avgAnkleY);
  if (STATE.recentAnkleY.length > 25) STATE.recentAnkleY.shift();
  if (STATE.recentAnkleY.length < 10) return;

  const groundY = Math.max(...STATE.recentAnkleY);
  const lift = groundY - avgAnkleY;

  // 自适应阈值：身体高度的 3%，最小不低于 3px（适配远距离）
  const jumpThresh = Math.max(3, Math.min(bodyHeight * 0.03, 20));
  const landThresh = Math.max(1.5, bodyHeight * 0.006);

  updateDebug('lift', lift.toFixed(0));
  updateDebug('th', jumpThresh.toFixed(0));
  updateDebug('gnd', groundY.toFixed(0));
  updateDebug('mdl', 'AI');

  if (!STATE.isJumping) {
    if (lift > jumpThresh) {
      STATE.isJumping = true;
    }
  } else {
    if (lift < landThresh && STATE.jumpCooldown <= 0) {
      STATE.jumpCount++;
      STATE.jumpCooldown = 12;
      STATE.isJumping = false;
      updateJumpDisplay();
      playJumpSound();
      if (navigator.vibrate) navigator.vibrate(15);
    }
  }

  if (STATE.jumpCooldown > 0) STATE.jumpCooldown--;
}

// ============ 备用方案：基于帧差运动检测 ============
// 不需要AI模型，通过分析画面像素变化来检测跳跃。
// 复用全局画布，每帧不创建新对象。
let motionBaseline = null;
let motionUp = false;

function detectMotionFallback(video) {
  if (STATE.isPaused || !STATE.exerciseActive) return;

  // 复用画布，极低分辨率
  const mc = _motionCanvas;
  mc.width = 40; mc.height = 30;
  const ctx = mc.getContext('2d');
  ctx.drawImage(video, 0, 0, 40, 30);
  const pixels = ctx.getImageData(0, 0, 40, 30).data;

  // 只对比画面下半部分的亮度变化
  const lowerStart = 40 * 15 * 4; // 第15行开始
  let diff = 0, n = 0;
  if (STATE.prevFrameData) {
    for (let i = lowerStart; i < pixels.length; i += 8) {
      const cur = (pixels[i] + pixels[i+1] + pixels[i+2]) / 3;
      const prev = (STATE.prevFrameData[i] + STATE.prevFrameData[i+1] + STATE.prevFrameData[i+2]) / 3;
      diff += Math.abs(cur - prev);
      n++;
    }
    diff = diff / n;
  }
  STATE.prevFrameData = new Uint8Array(pixels);

  // 维护运动基线（按大小顺序插入，避免全排序）
  motionBaseline = motionBaseline || [];
  motionBaseline.push(diff);
  if (motionBaseline.length > 60) motionBaseline.shift();
  if (motionBaseline.length < 20) return;

  // 取30%分位数（用部分排序替代全排序）
  const sorted = motionBaseline.slice().sort((a, b) => a - b);
  const quietLevel = sorted[Math.floor(sorted.length * 0.3)];

  const isMoving = diff > quietLevel * 2.5 && diff > 3;

  updateDebug('lift', diff.toFixed(1));
  updateDebug('th', (quietLevel * 2.5).toFixed(1));

  // 状态机
  if (!motionUp && isMoving) {
    motionUp = true;
  } else if (motionUp && !isMoving) {
    motionUp = false;
    if (STATE.jumpCooldown <= 0) {
      STATE.jumpCount++;
      STATE.jumpCooldown = 8;
      updateJumpDisplay();
      playJumpSound();
    }
  }

  if (STATE.jumpCooldown > 0) STATE.jumpCooldown--;
}

function updateJumpDisplay() {
  const el = document.getElementById('count-display');
  el.textContent = STATE.jumpCount;
  el.classList.remove('bounce');
  void el.offsetWidth;
  el.classList.add('bounce');
}

function updateDebug(id, val) {
  const el = document.getElementById('dbg-' + id);
  if (el) el.textContent = val;
}

// ============ 暂停/继续/重新开始 ============
function togglePause() {
  if (!STATE.exerciseActive) return;

  STATE.isPaused = !STATE.isPaused;

  if (STATE.isPaused) {
    document.getElementById('btn-pause').classList.add('hidden');
    document.getElementById('btn-resume').classList.remove('hidden');
    document.getElementById('btn-restart').classList.remove('hidden');
    document.getElementById('exercise-status').textContent = '已暂停 ⏸';
  } else {
    document.getElementById('btn-pause').classList.remove('hidden');
    document.getElementById('btn-resume').classList.add('hidden');
    document.getElementById('btn-restart').classList.add('hidden');
    document.getElementById('exercise-status').textContent = '识别正常 ✓';
  }
}

function confirmRestart() {
  showConfirm('确定重新开始吗？当前成绩将丢失', () => {
    // 停止当前
    clearInterval(STATE.timerInterval);
    STATE.timerInterval = null;
    STATE.exerciseActive = false;
    STATE.isPaused = false;
    STATE.jumpCount = 0;
    STATE.timeRemaining = 60;

    // 重置展示
    document.getElementById('timer-display').textContent = '60';
    document.getElementById('timer-display').classList.remove('warning');
    document.getElementById('count-display').textContent = '0';

    // 重新开始 3-2-1
    STATE.exerciseActive = true;
    countdown321().then(() => {
      startTimer();
      document.getElementById('btn-pause').classList.remove('hidden');
      document.getElementById('btn-resume').classList.add('hidden');
      document.getElementById('btn-restart').classList.add('hidden');
      STATE.isPaused = false;
    });
  });
}

// ============ 结束运动 ============
function endExercise() {
  STATE.exerciseActive = false;
  STATE.isPaused = false;

  // 停止检测和相机
  stopDetection();
  stopCamera();

  // 计算卡路里（约0.15卡/跳，基于50kg估算）
  const calPerJump = 0.15;
  const calories = Math.round(STATE.jumpCount * calPerJump);
  const avgPerSec = (STATE.jumpCount / 60).toFixed(1);

  // 星级评价
  const stars = getStars(STATE.jumpCount);

  // 激励文案
  const message = getMotivation(STATE.jumpCount);

  // 保存结果
  STATE.currentResult = {
    count: STATE.jumpCount,
    avg: avgPerSec,
    calories: calories,
    time: '60s',
    stars: stars,
    message: message,
    date: new Date().toISOString()
  };

  // 保存到历史记录
  saveToHistory(STATE.currentResult);

  // 切换到结算界面
  setTimeout(() => {
    switchPage('result');
    renderResult();

    // 彩蛋特效
    if (STATE.jumpCount >= 100) {
      launchConfetti();
    }
  }, 500);
}

// ============ 结算界面 ============
function renderResult() {
  const r = STATE.currentResult;
  if (!r) return;

  document.getElementById('result-count').textContent = r.count;
  document.getElementById('result-avg').textContent = r.avg;
  document.getElementById('result-cal').textContent = r.calories;
  document.getElementById('result-message').textContent = r.message;

  // 星星渲染
  const starEl = document.getElementById('result-stars');
  const fullStar = '⭐';
  const emptyStar = '☆';
  starEl.textContent = fullStar.repeat(r.stars) + emptyStar.repeat(Math.max(0, 5 - r.stars));

  // 庆祝短音效
  playCelebration();
}

function getStars(count) {
  if (count >= 180) return 5;
  if (count >= 150) return 4;
  if (count >= 130) return 3;
  if (count >= 100) return 2;
  if (count >= 1) return 1;
  return 0;
}

function getMotivation(count) {
  if (count >= 200) return '🏆 太棒了！跳绳达人！';
  if (count >= 180) return '🌟 优秀！满分水平！突破自我～';
  if (count >= 150) return '💪 很好！保持训练，继续加油！';
  if (count >= 130) return '👏 不错！再接再厉！';
  if (count >= 100) return '👍 继续努力，下次更优秀！';
  if (count >= 50) return '🌱 有进步空间，加油练习！';
  return '💪 第一次完成，继续加油！';
}

// ============ 打卡 ============
function checkIn() {
  const r = STATE.currentResult;
  if (!r) return;

  showModal('打卡成功 🎉',
    `今日成绩：${r.count} 次\n` +
    `平均速度：${r.avg} 跳/秒\n` +
    `星级评价：${'⭐'.repeat(r.stars)}\n\n` +
    `成绩已记录，继续保持训练！`
  );
}

// ============ 分享 ============
function shareResult() {
  const r = STATE.currentResult;
  if (!r) return;

  const shareText =
    `🏃 爱上跳绳 - 一分钟挑战\n` +
    `📊 ${r.count} 次 | ${'⭐'.repeat(r.stars)}\n` +
    `⏱️ 平均 ${r.avg} 跳/秒 | 🔥 ${r.calories} 卡\n` +
    `${r.message}\n` +
    `快来挑战吧！🏆`;

  // 尝试 Web Share API
  if (navigator.share) {
    navigator.share({
      title: '爱上跳绳 - 一分钟挑战',
      text: shareText,
    }).catch(() => {});
  } else {
    // 回退：复制到剪贴板
    copyToClipboard(shareText);
    showModal('分享已复制', '分享内容已复制到剪贴板，请粘贴到微信/QQ等平台');
  }
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  } else {
    // 降级方案
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

// ============ 历史记录 ============
function saveToHistory(record) {
  STATE.history.unshift(record);
  if (STATE.history.length > 200) STATE.history.pop();
  localStorage.setItem('jump_history', JSON.stringify(STATE.history));
}

function loadHistory() {
  try {
    const data = localStorage.getItem('jump_history');
    if (data) STATE.history = JSON.parse(data);
  } catch (e) {
    STATE.history = [];
  }
}

function renderHistory() {
  const container = document.getElementById('history-content');

  if (STATE.history.length === 0) {
    container.innerHTML = `
      <div class="history-empty">
        <div class="empty-icon">📋</div>
        <p>暂无记录</p>
        <p class="empty-sub">完成一分钟跳绳后，成绩将自动保存</p>
        <button class="btn btn-primary" onclick="navigateTo('prepare')">开始第一次训练</button>
      </div>
    `;
    return;
  }

  let html = '<div class="history-list">';
  STATE.history.forEach((item, index) => {
    const date = new Date(item.date);
    const dateStr = `${date.getMonth()+1}月${date.getDate()}日 ${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`;
    const stars = '⭐'.repeat(item.stars) + '☆'.repeat(5 - item.stars);

    html += `
      <div class="history-item" style="animation-delay: ${index * 0.05}s">
        <div class="history-item-stars">${item.stars >= 4 ? '🏆' : item.stars >= 2 ? '💪' : '🌱'}</div>
        <div class="history-item-info">
          <div class="history-item-count">${item.count} 次</div>
          <div class="history-item-meta">${stars} | 平均 ${item.avg} 跳/秒</div>
        </div>
        <div class="history-item-date">${dateStr}</div>
        <button class="history-item-del" onclick="deleteHistory(${index})">✕</button>
      </div>
    `;
  });
  html += '</div>';

  // 最佳成绩
  const best = Math.max(...STATE.history.map(h => h.count));
  html += `
    <div style="text-align:center;padding:16px;font-size:13px;color:var(--text-light);">
      个人最佳：🏆 <strong style="color:var(--primary);">${best}</strong> 次
    </div>
  `;

  container.innerHTML = html;
}

function deleteHistory(index) {
  showConfirm('确定删除这条记录吗？', () => {
    STATE.history.splice(index, 1);
    localStorage.setItem('jump_history', JSON.stringify(STATE.history));
    renderHistory();
  });
}

function clearHistory() {
  if (STATE.history.length === 0) return;
  showConfirm('确定清空所有历史记录吗？此操作不可恢复', () => {
    STATE.history = [];
    localStorage.removeItem('jump_history');
    renderHistory();
  });
}

// ============ 音频系统 ============
function speak(text) {
  if (!STATE.soundEnabled) return;

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 0.9;
    utterance.pitch = 1.1;
    window.speechSynthesis.speak(utterance);
  } catch (e) {
    // 静默失败
  }
}

function speakNumber(num) {
  const map = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 10: '十' };
  speak(map[num] || String(num));
}

function playJumpSound() {
  if (!STATE.soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // "叮咚"音效 - 两个短音符
    [1200, 1500].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      const t = ctx.currentTime + i * 0.06;
      gain.gain.setValueAtTime(0.15, t);
      gain.gain.exponentialRampToValueAtTime(0.01, t + 0.08);
      osc.start(t);
      osc.stop(t + 0.08);
    });
  } catch (e) {}
}

function playCelebration() {
  if (!STATE.soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // 一连串上升音符
    [523, 659, 784, 1047].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.12 + 0.15);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.15);
    });
  } catch (e) {}
}

// ============ 粒子彩蛋 ============
function launchConfetti() {
  const colors = ['#FF8C42', '#4A90D9', '#FFD700', '#27AE60', '#E74C3C', '#9B59B6'];
  for (let i = 0; i < 40; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    el.style.left = Math.random() * 100 + '%';
    el.style.top = '-10px';
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.width = (6 + Math.random() * 8) + 'px';
    el.style.height = (6 + Math.random() * 8) + 'px';
    el.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    el.style.setProperty('--duration', (1.5 + Math.random() * 2) + 's');
    el.style.animationDelay = Math.random() * 0.8 + 's';
    document.body.appendChild(el);

    setTimeout(() => el.remove(), 4000);
  }
}

// ============ 绘制姿势 ============
function drawPose(canvas, keypoints, width, height) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);

  // 调整尺寸以匹配显示
  canvas.style.width = '100%';
  canvas.style.height = '100%';

  // 连接骨架
  const connections = [
    [5, 6],   // 肩膀
    [5, 7], [7, 9],   // 左臂
    [6, 8], [8, 10],  // 右臂
    [5, 11], [6, 12], // 躯干
    [11, 13], [13, 15], // 左腿
    [12, 14], [14, 16], // 右腿
    [11, 12], // 胯部
  ];

  const CONF = 0.2;
  ctx.strokeStyle = STATE.isPaused ? 'rgba(255,255,255,0.3)' : 'rgba(74, 180, 100, 0.7)';
  ctx.lineWidth = 3;

  connections.forEach(([i, j]) => {
    const a = keypoints[i];
    const b = keypoints[j];
    if (a && b && a.score > CONF && b.score > CONF) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  });

  // 绘制脚踝关键点
  [15, 16].forEach(i => {
    const kp = keypoints[i];
    if (kp && kp.score > CONF) {
      ctx.beginPath();
      ctx.arc(kp.x, kp.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = STATE.isJumping ? '#FF8C42' : '#4A90D9';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });

  // 绘制识别框
  const visible = keypoints.filter(k => k.score > CONF);
  if (visible.length < 3) return;
  const minX = Math.min(...visible.map(k => k.x));
  const minY = Math.min(...visible.map(k => k.y));
  const maxX = Math.max(...visible.map(k => k.x));
  const maxY = Math.max(...visible.map(k => k.y));

  if (isFinite(minX) && isFinite(minY)) {
    const pad = 20;
    ctx.strokeStyle = STATE.isPaused ? 'rgba(255,255,255,0.3)' : 'rgba(74, 180, 100, 0.5)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(
      minX - pad, minY - pad,
      maxX - minX + pad * 2, maxY - minY + pad * 2
    );
    ctx.setLineDash([]);
  }
}

// ============ 弹窗系统 ============
function showModal(title, body) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent = body;
  document.getElementById('modal-generic').classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function showConfirm(text, onConfirm) {
  const modal = document.getElementById('modal-generic');
  document.getElementById('modal-title').textContent = '提示';
  document.getElementById('modal-body').textContent = text;
  const btn = document.getElementById('modal-btn');
  btn.textContent = '确定';
  btn.onclick = () => {
    closeModal('modal-generic');
    if (onConfirm) onConfirm();
  };
  modal.classList.remove('hidden');
}

function showHelp() {
  document.getElementById('modal-help').classList.remove('hidden');
}

// ============ 清理 ============
function stopExercise() {
  STATE.exerciseActive = false;
  STATE.isPaused = false;
  STATE.jumpCount = 0;
  STATE.timeRemaining = 60;
  motionBaseline = null;
  STATE.prevFrameData = null;

  const dp = document.getElementById('dbg-panel');
  if (dp) dp.style.display = 'none';

  if (STATE.timerInterval) {
    clearInterval(STATE.timerInterval);
    STATE.timerInterval = null;
  }

  stopDetection();
  stopCamera();
}

// ============ 键盘快捷键 ============
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!document.getElementById('modal-help').classList.contains('hidden')) {
      closeModal('modal-help');
    } else if (!document.getElementById('modal-generic').classList.contains('hidden')) {
      closeModal('modal-generic');
    }
  }
});
