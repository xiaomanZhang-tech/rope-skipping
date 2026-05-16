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
  vBuf: [],           // 速度计算缓冲区
  jumpPeak: 0,        // 当前跳跃最高幅度
  jumpFrames: 0,      // 跳跃持续帧数
  prevFrameData: null,    // 备用方案的上一帧数据
  motionMode: false,      // 是否使用无AI运动检测
  modelLoadAttempted: false,
  bodyDetected: false,    // 是否已检测到人体
  autoStartCountdown: -1, // -1=未触发, 0=倒计时结束, >0=倒计时中(半秒步长)
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
  // 加载CDN AI库（库加载完成后自动调用 preloadDetector）
  if (window._bootLibs) {
    window._bootLibs(function(success) {
      if (success) preloadDetector();
      else {
        STATE.motionMode = true;
        STATE.modelLoadAttempted = true;
        setModelStatus('CDN加载失败，使用运动检测备用方案');
      }
    });
  } else {
    preloadDetector();
  }
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
  if (page !== 'prepare') stopBodyPreview();
}

// ============ 首页 ============
// 纯 HTML 展示

// ============ 准备界面 ============
async function initPreparePage() {
  const btn = document.getElementById('btn-start');
  const permissionPrompt = document.getElementById('permission-prompt');

  btn.disabled = true;

  // 尝试加载AI库（如果CDN失败则走纯运动检测）
  if (typeof poseDetection === 'undefined') {
    document.getElementById('btn-start-text').textContent = 'CDN加载中...';
    await new Promise(function(resolve) {
      // 等待最长时间4秒让CDN加载
      var check = function() {
        if (typeof poseDetection !== 'undefined') { resolve(); return; }
        setTimeout(check, 200);
      };
      setTimeout(function() { resolve(); }, 4000);
      check();
    });
  }

  if (typeof poseDetection === 'undefined') {
    STATE.motionMode = true;
    STATE.modelLoadAttempted = true;
    setModelStatus('AI库加载失败，使用运动检测备用方案');
  } else {
    // 等待模型加载完成（_bootLibs 可能已在后台触发 preloadDetector）
    for (let _mi = 0; _mi < 50; _mi++) {
      if (!STATE.modelLoading || STATE.modelLoadAttempted || STATE.detector) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!STATE.detector && !STATE.modelLoadAttempted) {
      await preloadDetector();
    }
  }

  // 显示重试按钮(如果模型加载失败)
  const retryBtn = document.getElementById('btn-retry-ai');
  if (STATE.detector) {
    if (retryBtn) retryBtn.style.display = 'none';
  } else if (STATE.modelLoadAttempted) {
    if (retryBtn) retryBtn.style.display = 'block';
  }

  permissionPrompt.classList.add('hidden');

  // 尝试开启相机
  try {
    await startCamera('prepare');
    document.getElementById('camera-placeholder').classList.add('hidden');
    // 启动身体检测预览
    startBodyPreview();
    // 按钮状态由 bodyPreview 控制
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
      width: { ideal: 640 },
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

// ============ AI 模型加载（自托管模型文件，无需外网） ============
async function preloadDetector() {
  if (STATE.detector || STATE.modelLoading) return;
  STATE.modelLoading = true;
  setModelStatus('正在加载AI模型...');

  // 模型URL列表（CDN > 自托管GitHub Pages）
  const modelUrls = [
    'https://gcore.jsdelivr.net/gh/xiaomanZhang-tech/rope-skipping@main/models/movenet/model.json',
    'models/movenet/model.json'
  ];
  var lastErr;

  for (let _mi = 0; _mi < modelUrls.length; _mi++) {
    if (_mi > 0) setModelStatus('CDN失败，尝试本地模型...');
    try {
      const cfg = {
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
        modelUrl: modelUrls[_mi]
      };
      STATE.detector = await Promise.race([
        poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, cfg),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('超时(>30s)')), 30000)
        )
      ]);
      STATE.modelLoadAttempted = true;
      STATE.motionMode = false;
      setModelStatus('✓ AI骨骼识别 已就绪');
      console.log('MoveNet loaded from:', modelUrls[_mi]);
      STATE.modelLoading = false;
      return;
    } catch (err) {
      lastErr = err;
      console.error('Model URL ' + modelUrls[_mi] + ' failed:', err);
      STATE.detector = null;
      STATE.motionMode = true;
    }
  }
  STATE.modelLoadAttempted = true;
  setModelStatus('AI模型加载失败(' + (lastErr ? lastErr.message : '所有线路均失败') + ')，使用运动检测备用方案');
  STATE.modelLoading = false;
}

function setModelStatus(msg) {
  const el = document.getElementById('model-status');
  if (el) el.textContent = msg;
}

function retryModelLoad() {
  STATE.modelLoadAttempted = false;
  STATE.detector = null;
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-start-text').textContent = '加载模型中...';
  preloadDetector();
}

function getModeLabel() {
  if (STATE.motionMode) return '备用方案(帧差)';
  if (STATE.detector) return 'AI骨骼识别';
  return '未就绪';
}

// ============ 身体检测预览（准备界面） ============
let _bodyPreviewTimer = null;

function startBodyPreview() {
  stopBodyPreview();
  _bodyPreviewTimer = setInterval(runBodyPreview, 500);
  runBodyPreview();
}

function stopBodyPreview() {
  STATE.autoStartCountdown = -1;
  if (_bodyPreviewTimer) {
    clearInterval(_bodyPreviewTimer);
    _bodyPreviewTimer = null;
  }
  // 清理预览画布
  const canvas = document.getElementById('pose-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  // 恢复按钮文字
  const btn = document.getElementById('btn-start');
  if (btn) {
    btn.disabled = false;
    document.getElementById('btn-start-text').textContent = '开始跳绳';
  }
  // 隐藏状态
  const statusEl = document.getElementById('body-status');
  if (statusEl) statusEl.classList.add('hidden');
}

async function runBodyPreview() {
  const videoEl = document.getElementById('video');
  if (!videoEl || !videoEl.readyState || !STATE.cameraReady) return;

  const btn = document.getElementById('btn-start');
  const statusEl = document.getElementById('body-status');
  if (!statusEl) return;

  if (STATE.detector && !STATE.motionMode) {
    // === AI模式：检测骨骼点 ===
    try {
      const poses = await STATE.detector.estimatePoses(videoEl, {
        flipHorizontal: STATE.usingFrontCamera
      });
      if (poses && poses.length > 0) {
        const kp = poses[0].keypoints;
        // 在画布上绘制骨骼
        drawPose(document.getElementById('pose-canvas'), kp, videoEl.videoWidth, videoEl.videoHeight);

        // 检查关键身体部位是否可见
        const needed = [0, 5, 6, 11, 12, 15, 16]; // 鼻子、双肩、双胯、双脚踝
        const visible = needed.filter(i => kp[i] && kp[i].score > 0.2).length;
        const allVisible = visible === needed.length;

        // 检查身体高度是否足够（脚踝在画面下半部分，鼻子在上半部分）
        const nose = kp[0];
        const la = kp[15], ra = kp[16];
        const ankles = [];
        if (la.score > 0.2) ankles.push(la);
        if (ra.score > 0.2) ankles.push(ra);
        const hasHeight = nose.score > 0.2 && ankles.length > 0
          && nose.y < videoEl.videoHeight * 0.5
          && ankles.some(a => a.y > videoEl.videoHeight * 0.5);

        if (allVisible && hasHeight) {
          // 检测到全身 → 自动倒计时开始
          if (STATE.autoStartCountdown === -1 && !STATE.exerciseActive) {
            STATE.autoStartCountdown = 6; // 6 ticks × 500ms = 3秒
          }

          if (STATE.autoStartCountdown === 0) {
            // 倒计时结束，开始跳绳
            STATE.autoStartCountdown = -1;
            btn.disabled = true;
            document.getElementById('btn-start-text').textContent = '开始！';
            startExercise({skipCountdown: true});
            return;
          }

          if (STATE.autoStartCountdown > 0) {
            const secs = Math.ceil(STATE.autoStartCountdown / 2);
            statusEl.className = 'body-status body-ok';
            statusEl.innerHTML = `⏳ ${secs}`;
            STATE.autoStartCountdown--;
            btn.disabled = true;
            document.getElementById('btn-start-text').textContent = '自动开始中...';
          } else {
            statusEl.className = 'body-status body-ok';
            statusEl.innerHTML = '✓ 全身已检测  (骨骼识别)';
            btn.disabled = false;
            document.getElementById('btn-start-text').textContent = '开始跳绳';
          }
        } else {
          // 身体不完整 → 取消倒计时
          STATE.autoStartCountdown = -1;
          if (visible >= 5) {
            statusEl.className = 'body-status body-warn';
            const msg = ankles.length === 0 ? '请后退，让脚部入镜' : '请后退，让全身入镜';
            statusEl.innerHTML = '⚠ ' + msg;
            btn.disabled = true;
            document.getElementById('btn-start-text').textContent = '调整位置中...';
          } else {
            statusEl.className = 'body-status body-warn';
            statusEl.innerHTML = '⚠ 未检测到完整身体';
            btn.disabled = true;
            document.getElementById('btn-start-text').textContent = '调整位置中...';
          }
        }
        statusEl.classList.remove('hidden');
      } else {
        STATE.autoStartCountdown = -1;
        statusEl.className = 'body-status body-warn';
        statusEl.innerHTML = '⚠ 未检测到人体';
        btn.disabled = true;
        document.getElementById('btn-start-text').textContent = '请站到画面中央';
        statusEl.classList.remove('hidden');
      }
    } catch (e) {
      // 降级处理
    }
  } else {
    // === 运动检测模式：简化提示 ===
    statusEl.className = 'body-status body-warn';
    statusEl.innerHTML = '运动检测模式（建议在AI模式下使用）';
    statusEl.classList.remove('hidden');
    btn.disabled = false;
    document.getElementById('btn-start-text').textContent = '开始跳绳';
  }
}

// ============ 运动核心逻辑 ============
async function startExercise(options = {}) {
  const skipCountdown = options.skipCountdown || false;

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
  STATE.bodyDetected = false;
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

  // 显示模式信息
  var modeLabel, modeColor;
  if (STATE.detector && !STATE.motionMode) {
    modeLabel = 'AI骨骼识别';
    modeColor = '#4A90D9';
  } else if (STATE.motionMode) {
    modeLabel = '运动检测(备用)';
    modeColor = '#FF8C42';
  } else {
    modeLabel = '基本检测';
    modeColor = '#999';
  }
  document.getElementById('exercise-status').textContent = '⚡ ' + modeLabel;

  // 启动检测
  startDetection();

  // 显示调试面板
  const dp = document.getElementById('dbg-panel');
  if (dp) dp.style.display = 'flex';

  if (skipCountdown) {
    // 准备页已确认身体，直接开始计时
    // 但等待一帧确保运动界面检测到身体
    await new Promise(r => setTimeout(r, 300));
    // 隐藏引导框
    var gc = document.getElementById('guide-canvas');
    if (gc) gc.style.opacity = '0';
    document.getElementById('exercise-status').textContent = '开始！';
    startTimer();
  } else {
    // 等待检测到人体（最多5秒，超时也继续）
    document.getElementById('exercise-status').textContent = '⏳ 正在识别身体...';
    for (let _w = 0; _w < 50; _w++) {
      if (STATE.bodyDetected) break;
      await new Promise(r => setTimeout(r, 100));
    }
    // 识别到全身后隐藏引导框
    var gc = document.getElementById('guide-canvas');
    if (gc) gc.style.opacity = '0';

    // 3-2-1 倒计时
    await countdown321();

    // 开始正式计时
    document.getElementById('exercise-status').textContent = '开始！';
    startTimer();
  }
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
// AI推理每80ms跑一次，骨骼绘制每240ms刷新一次
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

  // 人形引导框（画一次即可）
  let _guideDrawn = false;

  // AI推理节流：最小间隔80ms
  let lastAiTime = 0;
  const AI_INTERVAL = 60; // ms（原120→80→60ms）
  let drawSkip = 0;

  const detectFrame = async (now) => {
    if (!STATE.detectionRunning) return;

    const videoEl = document.getElementById('exercise-video');
    if (!videoEl || !videoEl.readyState) {
      STATE.detectionInterval = requestAnimationFrame(detectFrame);
      return;
    }

    _frameCount++;

    // 视频尺寸就绪后绘制一次人形引导框
    if (!_guideDrawn && videoEl.videoWidth > 0) {
      drawGuideSilhouette(document.getElementById('guide-canvas'), videoEl.videoWidth, videoEl.videoHeight);
      _guideDrawn = true;
    }

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
      // === 备用方案：帧差运动检测（降频到1/2帧） ===
      if (_frameCount % 2 === 0) {
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
// 优化版：双路径落地 + 降低门槛应对快跳
// 起跳：脚踝上抬速度 + 幅度双重确认
// 落地路径A（慢跳）：回到基线 + 下坠速度
// 落地路径B（快跳）：未完全回基线但幅度显著回落 + 不再上升
// 慢速晃动会被速度门过滤，不会误计
function processJumpPose(keypoints, frameHeight) {
  if (STATE.isPaused || !STATE.exerciseActive) return;

  const CONF = 0.2;
  const la = keypoints[15], ra = keypoints[16];
  const va = [];
  if (la.score > CONF) va.push(la);
  if (ra.score > CONF) va.push(ra);
  if (va.length === 0) { document.getElementById('exercise-status').textContent = '未检测到人体'; return; }

  // 全身检测检查（所有关键部位可见才允许开始）
  if (!STATE.bodyDetected) {
    const needed = [0, 5, 6, 11, 12, 15, 16];
    const visible = needed.filter(i => keypoints[i] && keypoints[i].score > 0.2).length;
    const allVisible = visible === needed.length;
    const nose = keypoints[0];
    const hasHeight = nose.score > 0.2
      && nose.y < frameHeight * 0.5
      && (la.score > 0.2 && la.y > frameHeight * 0.5 || ra.score > 0.2 && ra.y > frameHeight * 0.5);
    if (allVisible && hasHeight) {
      STATE.bodyDetected = true;
      document.getElementById('exercise-status').textContent = '✓ 全身已识别';
    } else if (visible >= 5) {
      const msg = va.length === 0 ? '请后退，让脚部入镜' : '请调整位置，让全身入镜';
      document.getElementById('exercise-status').textContent = '⚠ ' + msg;
    } else {
      document.getElementById('exercise-status').textContent = '⚠ 未检测到完整身体';
    }
    return;
  }

  document.getElementById('exercise-status').textContent = '✓ 识别正常';

  const y = va.reduce((s, a) => s + a.y, 0) / va.length;

  // 身体高度
  const nose = keypoints[0];
  let bh = frameHeight * 0.55;
  if (nose && nose.score > CONF) bh = y - nose.y;
  else {
    const ls = keypoints[5], rs = keypoints[6];
    if (ls.score > CONF && rs.score > CONF) bh = y - (ls.y + rs.y) / 2;
  }
  if (bh < frameHeight * 0.12) bh = frameHeight * 0.55;

  // === 速度计算（加权平滑，最近帧权重更大） ===
  STATE.vBuf = STATE.vBuf || [];
  STATE.vBuf.push(y);
  if (STATE.vBuf.length > 3) STATE.vBuf.shift();

  let vel = 0;
  if (STATE.vBuf.length === 3) {
    vel = (STATE.vBuf[2] - STATE.vBuf[1]) * 0.6 + (STATE.vBuf[1] - STATE.vBuf[0]) * 0.4;
  }

  // === 位置基线（窗口缩小，更快适应姿态变化） ===
  STATE.recentAnkleY.push(y);
  if (STATE.recentAnkleY.length > 15) STATE.recentAnkleY.shift();
  if (STATE.recentAnkleY.length < 8) return;

  const ground = Math.max(...STATE.recentAnkleY);
  const lift = ground - y;

  // === 自适应阈值（降低门槛） ===
  const velTh = Math.max(0.8, bh * 0.005);    // 起跳速度门
  const ampTh = Math.max(2, bh * 0.012);      // 最小起跳幅度
  const landTh = Math.max(1, bh * 0.004);     // 落地判定

  updateDebug('lift', lift.toFixed(0));
  updateDebug('th', ampTh.toFixed(0));
  updateDebug('gnd', ground.toFixed(0));
  updateDebug('mdl', 'AI');

  // === 状态机 ===
  if (!STATE.isJumping) {
    // 起跳：速度向上 + 幅度足够
    if (vel < -velTh && lift > ampTh) {
      STATE.isJumping = true;
      STATE.jumpPeak = lift;
      STATE.jumpFrames = 0;
    }
  } else {
    STATE.jumpFrames = (STATE.jumpFrames || 0) + 1;
    if (lift > STATE.jumpPeak) STATE.jumpPeak = lift;

    // === 落地判定（双路径） ===
    // 路径A（慢跳/标准）：回到基线 + 不下坠
    const landedStrict = STATE.jumpPeak > ampTh && lift < landTh && vel >= 0;
    // 路径B（快跳）：幅度回落 + 不再上升
    const dropRatio = STATE.jumpPeak > 0 ? lift / STATE.jumpPeak : 1;
    const landedFast = STATE.jumpPeak > ampTh * 1.2 && STATE.jumpFrames >= 2 && dropRatio < 0.7 && vel >= 0;

    if ((landedStrict || landedFast) && STATE.jumpCooldown <= 0) {
      STATE.jumpCount++;
      STATE.jumpCooldown = 3;   // 原14→5→3（60ms×3=180ms冷却）
      STATE.isJumping = false;
      STATE.jumpPeak = 0;
      STATE.jumpFrames = 0;
      updateJumpDisplay();
      playJumpSound();
      if (navigator.vibrate) navigator.vibrate(15);
    }

    // 超时重置（原30→15→10）
    if (STATE.jumpFrames > 10) {
      STATE.isJumping = false;
      STATE.jumpPeak = 0;
      STATE.jumpFrames = 0;
    }
  }

  if (STATE.jumpCooldown > 0) STATE.jumpCooldown--;
}

// ============ 备用方案：增强型分层运动检测 ============
// 将画面分为4个水平区域，追踪垂直方向的速度变化。
// 跳跃模式 = 腿部区域先向上移动（速度↑）→ 再向下移动（速度↓）
// 摇头、摆手等非跳跃动作会被速度模式和区域分析过滤掉
//
// 核心改进：
// 1. 垂直速度追踪（不是简单的帧差量）
// 2. 完整"起跳-腾空-落地"周期检测
// 3. 腿部为主、全身协调为辅助判断
// 4. 自适应阈值

let _motionState = {
  // 状态机
  phase: 'ground',     // ground → launch → air → land → count
  groundFrames: 0,
  launchFrames: 0,
  airFrames: 0,

  // 运动量追踪（4个区域：头、上身、大腿、小腿）
  zoneMotion: [0, 0, 0, 0],
  prevFrame: null,

  // 垂直运动追踪
  verticalVel: 0,      // >0 = 向上, <0 = 向下
  verticalAccum: [],    // 最近5帧的垂直运动
  launchStrength: 0,

  // 自适应阈值
  noiseLevel: 5,
  adaptCounter: 0,

  // 光流追踪
  lastBotY: null,
  botVelocities: []
};

function detectMotionFallback(video) {
  if (_frameCount > 20) STATE.bodyDetected = true;
  if (STATE.isPaused || !STATE.exerciseActive) return;
  const ms = _motionState;

  // === 第1步：采集降采样帧（80×60 = 4倍提升） ===
  const mc = _motionCanvas;
  mc.width = 80; mc.height = 60;
  const ctx = mc.getContext('2d');
  ctx.drawImage(video, 0, 0, 80, 60);
  const p = ctx.getImageData(0, 0, 80, 60).data;

  // === 第2步：按4个水平区域计算运动量 ===
  // 区域0: 头部 (rows 0-14)  区域1: 躯干 (rows 15-29)
  // 区域2: 大腿 (rows 30-44) 区域3: 小腿/脚 (rows 45-59)
  const zoneDiffs = [0, 0, 0, 0];
  const zoneCounts = [0, 0, 0, 0];

  // 垂直运动追踪：分别追踪每个区域的垂直方向移动
  let totalVerticalMotion = 0;
  let vMotionCount = 0;

  if (ms.prevFrame) {
    const prev = ms.prevFrame;
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 80; x++) {
        const i = (y * 80 + x) * 4;
        const cur = (p[i] + p[i+1] + p[i+2]) / 3;
        const prev = (prev[i] + prev[i+1] + prev[i+2]) / 3;
        const d = Math.abs(cur - prev);

        // 区域分配
        const zone = Math.min(3, Math.floor(y / 15));
        zoneDiffs[zone] += d;
        zoneCounts[zone]++;

        // 垂直运动：比较当前与上方像素的差异变化
        if (y > 1 && y < 59) {
          const up = (p[i - 80] + p[i - 80 + 1] + p[i - 80 + 2]) / 3;
          const curV = cur - up;
          const prevUp = (prev[i - 80] + prev[i - 80 + 1] + prev[i - 80 + 2]) / 3;
          const prevV = prev - prevUp;
          totalVerticalMotion += (curV - prevV);
          vMotionCount++;
        }
      }
    }

    // 归一化
    for (let z = 0; z < 4; z++) {
      zoneDiffs[z] = zoneCounts[z] > 0 ? zoneDiffs[z] / zoneCounts[z] : 0;
    }

    // 垂直运动（正值=向上，负值=向下）
    const avgVert = vMotionCount > 0 ? totalVerticalMotion / vMotionCount : 0;

    // 平滑垂直速度（指数移动平均）
    ms.verticalVel = ms.verticalVel * 0.6 + avgVert * 0.4;

    // 累积垂直运动（最近5帧）
    ms.verticalAccum.push(avgVert);
    if (ms.verticalAccum.length > 5) ms.verticalAccum.shift();
  }
  ms.prevFrame = new Uint8Array(p);

  // === 第3步：计算关键指标 ===
  const legMotion = (zoneDiffs[2] + zoneDiffs[3]) / 2;    // 腿部运动量
  const bodyMotion = (zoneDiffs[1] + zoneDiffs[2]) / 2;    // 身体运动量
  const headMotion = zoneDiffs[0];                           // 头部运动量

  // 腿部运动占比（过滤头部晃动：头动腿不动 = 无效）
  const legRatio = bodyMotion > 0 ? legMotion / bodyMotion : 0;

  // 垂直动能（起跳时腿部明显向上）
  const vertVel = ms.verticalVel;

  // 垂直加速度（正=加速向上，负=减速向上或下落）
  const vertAcc = ms.verticalAccum.length >= 3
    ? (ms.verticalAccum[ms.verticalAccum.length - 1] - ms.verticalAccum[0]) / ms.verticalAccum.length
    : 0;

  // === 第4步：自适应阈值 ===
  // 根据当前噪声水平动态调整
  ms.adaptCounter++;
  if (ms.adaptCounter % 15 === 0 && STATE.timeRemaining < 58) {
    const noise = legMotion * 0.3 + headMotion * 0.7;
    ms.noiseLevel = Math.max(3, Math.min(20, ms.noiseLevel * 0.9 + noise * 0.1));
  }

  // 起跳检测阈值
  const launchTh = Math.max(3, ms.noiseLevel * 0.6);
  const legMotionTh = Math.max(2, ms.noiseLevel * 0.4);
  const vertUpTh = 0.04;     // 垂直向上速度阈值（原0.08）
  const vertDownTh = -0.03;  // 垂直向下速度阈值（原-0.05）
  const legRatioTh = 0.35;   // 腿部运动占比（防头部晃动误计）

  // 调试展示
  updateDebug('lift', legMotion.toFixed(1));
  updateDebug('th', launchTh.toFixed(1));
  updateDebug('gnd', ms.noiseLevel.toFixed(1));
  updateDebug('mdl', '帧差+v');

  // === 第5步：三阶段状态机 ===
  // phase: ground(地面) → launch(起跳) → air(腾空) → land(落地) → count
  //
  // 起跳条件：腿部运动 + 垂直向上速度 + 腿部占比
  // 落地条件：垂直向下速度 + 之前确实起跳了
  // 摇头/摆手：腿部占比低 → 被过滤

  switch (ms.phase) {
    case 'ground':
      // 需要连续多帧腿动+向上才能触发
      if (legMotion > legMotionTh && legRatio > legRatioTh) {
        ms.groundFrames++;
      } else {
        ms.groundFrames = 0;
      }
      if (ms.groundFrames >= 1) {
        ms.phase = 'launch';
        ms.launchFrames = 0;
        ms.launchStrength = legMotion;
        ms.groundFrames = 0;
      }
      break;

    case 'launch':
      ms.launchFrames++;
      ms.launchStrength = Math.max(ms.launchStrength, legMotion);
      // 起跳后等待垂直速度逆转（向上→向下）才进入落地阶段
      // 或者超时保护
      if (vertVel < vertDownTh || ms.launchFrames > 8) {
        if (ms.launchStrength > launchTh) {
          ms.phase = 'air';
          ms.airFrames = 0;
        } else {
          ms.phase = 'ground'; // 假启动，不够强
        }
      }
      break;

    case 'air':
      ms.airFrames++;
      // 在空中等待下落信号：垂直速度向下 + 运动趋于平静
      // 双路径：标准慢跳等向下速度，快跳运动回落即计数
      var airSlow2 = vertVel < vertDownTh && legMotion < legMotionTh * 1.5;
      var airFast2 = ms.airFrames >= 2 && legMotion < launchTh * 1.5;
      if (airSlow2 || airFast2 || ms.airFrames > 6) {
        // 计数！
        if (STATE.jumpCooldown <= 0) {
          STATE.jumpCount++;
          STATE.jumpCooldown = 7;
          updateJumpDisplay();
          playJumpSound();
          if (navigator.vibrate) navigator.vibrate(15);
        }
        ms.phase = 'ground';
        ms.groundFrames = 0;
      }
      break;
  }

  // 冷却递减
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

// ============ 人形引导框（静态参考，帮助用户定位） ============
function drawGuideSilhouette(canvas, _vw, _vh) {
  if (!canvas) return;
  // 使用CSS像素尺寸 × devicePixelRatio，在Retina屏上不模糊
  const dpr = window.devicePixelRatio || 1;
  // 如果canvas还未布局，降级到window尺寸
  let cw = canvas.clientWidth;
  let ch = canvas.clientHeight;
  if (!cw || !ch) { cw = window.innerWidth; ch = window.innerHeight; }
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  // 用CSS像素坐标绘制
  const cx = cw / 2;
  const gh = ch * 0.72;
  const headR = gh * 0.09;
  const topY = (ch - gh) / 2;
  const headCx = cx;
  const headCy = topY + headR;
  const neckY = topY + headR * 2.2;
  const shoulderY = neckY;
  const shoulderW = headR * 1.7;
  const hipY = neckY + gh * 0.35;
  const hipW = headR * 1.3;
  const footY = topY + gh;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.lineWidth = 4;
  ctx.setLineDash([8, 6]);

  // Head
  ctx.beginPath();
  ctx.arc(headCx, headCy, headR, 0, Math.PI * 2);
  ctx.stroke();

  // Torso (trapezoid)
  ctx.beginPath();
  ctx.moveTo(cx - shoulderW, shoulderY);
  ctx.lineTo(cx + shoulderW, shoulderY);
  ctx.lineTo(cx + hipW, hipY);
  ctx.lineTo(cx - hipW, hipY);
  ctx.closePath();
  ctx.stroke();

  // Left arm
  ctx.beginPath();
  ctx.moveTo(cx - shoulderW, shoulderY);
  ctx.lineTo(cx - shoulderW - headR * 1.2, shoulderY + gh * 0.2);
  ctx.stroke();

  // Right arm
  ctx.beginPath();
  ctx.moveTo(cx + shoulderW, shoulderY);
  ctx.lineTo(cx + shoulderW + headR * 1.2, shoulderY + gh * 0.2);
  ctx.stroke();

  // Left leg
  ctx.beginPath();
  ctx.moveTo(cx - hipW * 0.6, hipY);
  ctx.lineTo(cx - hipW * 1.0, footY);
  ctx.stroke();

  // Right leg
  ctx.beginPath();
  ctx.moveTo(cx + hipW * 0.6, hipY);
  ctx.lineTo(cx + hipW * 1.0, footY);
  ctx.stroke();

  ctx.setLineDash([]);
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
  STATE.vBuf = [];
  STATE.jumpPeak = 0;
  STATE.jumpFrames = 0;
  STATE.prevFrameData = null;

  // 重置运动检测状态机
  _motionState = {
    phase: 'ground', groundFrames: 0, launchFrames: 0, airFrames: 0,
    zoneMotion: [0, 0, 0, 0],
    prevFrame: null, verticalVel: 0, verticalAccum: [],
    launchStrength: 0, noiseLevel: 5, adaptCounter: 0,
    lastBotY: null, botVelocities: []
  };

  const dp = document.getElementById('dbg-panel');
  if (dp) dp.style.display = 'none';

  if (STATE.timerInterval) {
    clearInterval(STATE.timerInterval);
    STATE.timerInterval = null;
  }

  stopDetection();
  stopBodyPreview();
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
