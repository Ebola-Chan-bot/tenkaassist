'use strict';
/*
 * labOptimizer.js —— LAB 战斗模拟页 · 单队指令优化器 UI 装配
 *
 * 在标题栏注入「指令优化」按钮与搜索面板：选定搜索速度档后开始搜索，实时展示阶段/评估数/当前最优/用时
 * 与管线日志（worker 消息流），完成后可【自动执行】（按 toks 逐动作驱动 do_ult/do_atk/do_def，含 undo 兼容）、
 * 【填入引导】（写入 commandList 并开启 guide 高亮）或【复制指令文本】（站点 description 格式）。
 *
 * 搜索配置逐项取自页面当前战斗状态（idList/bondList/boss.element/liParam/gboss/a_o/elvOn/elvList/hitAll），
 * 经 worker 的 lab 口径战斗装配后评估，因此搜出的最优序列与本页战斗语义一致（DebugTools 自检 bit-exact 背书）。
 *
 * 手动停止 = worker.terminate()：同步搜索期间消息通道不可入，terminate 即时生效；已发现的 best-so-far
 * 由「最优」消息留存，仍可应用。
 */
(function () {
   let worker = null, 搜索中 = false, 当前最优 = null, 播放定时器 = null;
   const 播放间隔ms = 150;

   const 动作名 = { '평': '普攻', '궁': '大招', '방': '防守' };

   // ================= UI 注入 =================
   function 建UI() {
      const 标题栏 = document.querySelector('#title-sim .titleblock');
      if (!标题栏) return;
      const btn = document.createElement('button');
      btn.id = 'optimBtn';
      btn.className = 'leaderButton leaderOff';
      btn.style.marginLeft = '0.2rem';
      btn.innerText = t('명령 최적화');
      btn.addEventListener('click', 开关面板);
      标题栏.appendChild(btn);

      const 面板 = document.createElement('div');
      面板.id = 'optimPanel';
      面板.style.display = 'none';
      面板.innerHTML = `
         <div class="optim-row">
            <span class="optim-label">${t('탐색 속도')}</span>
            <label><input type="radio" name="optim档" value="快速">${t('빠름')}</label>
            <label><input type="radio" name="optim档" value="标准" checked>${t('표준')}</label>
            <label><input type="radio" name="optim档" value="深度">${t('깊음')}</label>
            <button id="optimStart" class="optim-btn">${t('탐색 시작')}</button>
            <button id="optimStop" class="optim-btn" disabled>${t('중지')}</button>
         </div>
         <div class="optim-status">
            <span id="optimStage">${t('준비')}</span>
            <span id="optimBest"></span>
            <span id="optimStats"></span>
         </div>
         <div id="optimLog" class="optim-log"></div>
         <div class="optim-row">
            <button id="optimApply" class="optim-btn" disabled>${t('자동 실행')}</button>
            <button id="optimGuide" class="optim-btn" disabled>${t('가이드에 채우기')}</button>
            <button id="optimCopy" class="optim-btn" disabled>${t('명령 복사')}</button>
         </div>`;
      document.body.appendChild(面板);

      document.getElementById('optimStart').addEventListener('click', 开始搜索);
      document.getElementById('optimStop').addEventListener('click', 停止搜索);
      document.getElementById('optimApply').addEventListener('click', 自动执行);
      document.getElementById('optimGuide').addEventListener('click', 填入引导);
      document.getElementById('optimCopy').addEventListener('click', 复制指令);
   }

   function 开关面板() {
      const p = document.getElementById('optimPanel');
      p.style.display = p.style.display === 'none' ? 'block' : 'none';
   }
   function 取档() {
      const r = document.querySelector('input[name="optim档"]:checked');
      return r ? r.value : '标准';
   }
   function 追加日志(行) {
      const log = document.getElementById('optimLog');
      if (!log) return;
      const div = document.createElement('div');
      div.textContent = 行;
      log.appendChild(div);
      while (log.childElementCount > 400) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
   }

   // ================= 搜索 =================
   function 取页面配置() {
      const li = String(liParam || '0,0,0,0,0').split(',').map(Number);
      while (li.length < 5) li.push(0);
      return {
         ids: idList.slice(),
         bond: bondList.slice(),
         bossEl: (typeof boss !== 'undefined' && boss.element != null) ? boss.element : -1,
         li: li.slice(0, 5),
         gboss: gboss || 0,
         coefs: (typeof a_o !== 'undefined') ? a_o.map(k => [k[0], k[2], k[3]]) : null,
         elvOn: !!elvOn,
         elv: (typeof elvList !== 'undefined') ? elvList : null,
         hitAll: (typeof hitAll !== 'undefined') ? hitAll !== false : true,
         档: 取档(),
      };
   }

   function 开始搜索() {
      if (搜索中) return;
      if (typeof actNum !== 'undefined' && actNum !== 0) {
         if (!confirm(t('턴 1부터 시작할 때만 적용할 수 있습니다. 그래도 탐색할까요?'))) return;
      }
      搜索中 = true;
      当前最优 = null;
      document.getElementById('optimLog').innerHTML = '';
      document.getElementById('optimBest').textContent = '';
      document.getElementById('optimStats').textContent = '';
      document.getElementById('optimStage').textContent = t('최적 명령을 탐색 중...');
      document.getElementById('optimStart').disabled = true;
      document.getElementById('optimStop').disabled = false;
      for (const id of ['optimApply', 'optimGuide', 'optimCopy']) document.getElementById(id).disabled = true;

      if (worker) { try { worker.terminate(); } catch (e) {} }
      worker = new Worker(`${address}/lab/optimizer/优化worker.js`);
      worker.onmessage = (ev) => 处理消息(ev.data || {});
      worker.onerror = (e) => {
         搜索中 = false;
         document.getElementById('optimStage').textContent = t('탐색 실패');
         追加日志('worker error: ' + (e.message || e.type));
         document.getElementById('optimStart').disabled = false;
         document.getElementById('optimStop').disabled = true;
      };
      worker.postMessage({ t: '开始', cfg: 取页面配置() });
   }

   function 停止搜索() {
      if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
      搜索中 = false;
      document.getElementById('optimStage').textContent = 当前最优 ? t('중지됨') : t('중지됨');
      document.getElementById('optimStart').disabled = false;
      document.getElementById('optimStop').disabled = true;
      if (当前最优) 启用结果按钮();
   }

   function 启用结果按钮() {
      document.getElementById('optimApply').disabled = false;
      document.getElementById('optimGuide').disabled = false;
      document.getElementById('optimCopy').disabled = false;
   }

   let 统计评估 = 0, 统计用时 = 0;
   function 刷新统计() {
      const el = document.getElementById('optimStats');
      if (el) el.textContent = `${t('평가')}: ${统计评估.toLocaleString()} · ${t('소요')}: ${统计用时.toFixed(0)}s`;
   }
   function 处理消息(m) {
      switch (m.t) {
         case '就绪':
            追加日志(`✓ ${t('엔진 준비 완료')} ${(m.用时ms / 1000).toFixed(1)}s`);
            break;
         case '日志':
            追加日志(m.text);
            break;
         case '阶段':
            document.getElementById('optimStage').textContent = m.name;
            if (m.用时秒 != null) 统计用时 = m.用时秒;
            刷新统计();
            break;
         case '最优':
            当前最优 = { dmg: m.dmg, 来源: m.来源 };
            document.getElementById('optimBest').textContent =
               `${t('최적')}: ${Math.floor(m.dmg).toLocaleString()} (${m.来源})`;
            if (m.已评估 != null) 统计评估 = m.已评估;
            if (m.用时秒 != null) 统计用时 = m.用时秒;
            刷新统计();
            break;
         case '进度':
            document.getElementById('optimStage').textContent = m.阶段 || '';
            if (m.已评估 != null) 统计评估 = m.已评估;
            if (m.用时秒 != null) 统计用时 = m.用时秒;
            刷新统计();
            break;
         case '完成':
            搜索中 = false;
            document.getElementById('optimStart').disabled = false;
            document.getElementById('optimStop').disabled = true;
            if (m.零伤害) {
               document.getElementById('optimStage').textContent = t('데미지 0');
               break;
            }
            当前最优 = { dmg: m.dmg, 来源: m.来源, toks: m.toks, description: m.description };
            document.getElementById('optimStage').textContent = t('탐색 완료');
            document.getElementById('optimBest').textContent =
               `${t('최적')}: ${Math.floor(m.dmg).toLocaleString()} (${m.来源})`;
            document.getElementById('optimStats').textContent =
               `${t('평가')}: ${(m.已评估 || 0).toLocaleString()} · ${t('소요')}: ${(m.用时秒 || 0).toFixed(1)}s`;
            追加日志(`✓ ${t('탐색 완료')}  ${Math.floor(m.dmg).toLocaleString()}  [${m.来源}]`);
            启用结果按钮();
            break;
         case '失败':
            搜索中 = false;
            document.getElementById('optimStage').textContent = t('탐색 실패');
            追加日志('✗ ' + m.reason);
            document.getElementById('optimStart').disabled = false;
            document.getElementById('optimStop').disabled = true;
            break;
      }
   }

   // ================= 结果应用 =================
   function 自动执行() {
      if (!当前最优 || !当前最优.toks) return;
      if (typeof actNum !== 'undefined' && actNum !== 0) {
         alert(t('턴 1부터 시작할 때만 적용할 수 있습니다'));
         return;
      }
      if (播放定时器) { clearTimeout(播放定时器); 播放定时器 = null; }
      const toks = 当前最优.toks;
      let i = 0, 上一步 = -1;
      追加日志(`▶ ${t('자동 실행')} (${toks.length} actions)`);
      const 步进 = () => {
         if (i >= toks.length) { 追加日志('✓ ' + t('자동 실행 완료')); 播放定时器 = null; return; }
         const tk = toks[i];
         const 前 = (typeof actNum !== 'undefined') ? actNum : -1;
         if (tk.act === '궁') do_ult(tk.idx);
         else if (tk.act === '평') do_atk(tk.idx);
         else do_def(tk.idx);
         const 后 = (typeof actNum !== 'undefined') ? actNum : -1;
         if (后 === 前 && 上一步 !== -1) {
            追加日志('⚠ ' + t('행동이 거부되어 중단되었습니다'));
            播放定时器 = null;
            return;
         }
         上一步 = 后;
         i++;
         播放定时器 = setTimeout(步进, 播放间隔ms);
      };
      步进();
   }

   function 填入引导() {
      if (!当前最优 || !当前最优.toks) return;
      commandList = 当前最优.toks.map(tk => `${tk.idx + 1}${tk.act}`);
      isOn = true;
      const guideBtn = document.getElementById('guide');
      if (guideBtn) {
         guideBtn.classList.add('leaderOn');
         guideBtn.classList.remove('leaderOff');
      }
      updateGuide();
      追加日志(`✓ ${t('가이드에 채움')} (${commandList.length})`);
   }

   function 复制指令() {
      if (!当前最优 || !当前最优.description) return;
      const done = () => 追加日志('✓ ' + t('복사됨'));
      if (navigator.clipboard && navigator.clipboard.writeText) {
         navigator.clipboard.writeText(当前最优.description).then(done, () => fallback());
      } else fallback();
      function fallback() {
         const ta = document.createElement('textarea');
         ta.value = 当前最优.description;
         document.body.appendChild(ta);
         ta.select();
         try { document.execCommand('copy'); done(); } catch (e) { 追加日志('✗ copy failed'); }
         document.body.removeChild(ta);
      }
   }

   if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', 建UI);
   else 建UI();
})();
