/* ============================================================
   野性档案 SAVAGE ARCHIVE · beautify.js
   高好评美化库集成层
   - Lenis  平滑滚动（高级手感）
   - AOS    滚入动画（展厅区块）
   - Splitting.js + GSAP  标题拆字编排（主视觉）
   - Hover.css 由 HTML class 驱动（.hvr-*）
   全部刻意克制，不破坏现有档案馆审美。
   ============================================================ */
'use strict';

const BEAUTIFY = (() => {
  let lenis = null;
  let timer = null;
  let gsapLoaded = false;

  /* ---------- Lenis 平滑滚动 ---------- */
  function initLenis() {
    if (typeof Lenis === 'undefined') return;
    lenis = new Lenis({
      duration: 1.15,
      easing: t => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      touchMultiplier: 1.4
    });
    function raf(time) { lenis.raf(time); requestAnimationFrame(raf); }
    requestAnimationFrame(raf);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) lenis.resize(); });
  }
  function scrollTo(target) {
    if (lenis) lenis.scrollTo(target, { offset: -20, duration: 1.1 });
    else document.querySelector(target)?.scrollIntoView({ behavior: 'smooth' });
  }

  /* ---------- AOS 滚入 ---------- */
  function initAOS() {
    if (typeof AOS === 'undefined') return;
    document.querySelectorAll('#gallery, .colophon').forEach(el => el.setAttribute('data-aos-init', ''));
    AOS.init({
      duration: 720,
      easing: 'ease-out-cubic',
      offset: 80,
      once: true,
      disable: window.matchMedia('(prefers-reduced-motion: reduce)').matches
    });
  }

  /* ---------- GSAP 主视觉编排 ---------- */
  function staggerHero() {
    if (typeof gsap === 'undefined') return;
    gsapLoaded = true;
    const tl = gsap.timeline({ defaults: { ease: 'power4.out' } });
    tl.fromTo('#stooge-hero .hero-cn', { opacity: 0, y: 46, rotateZ: -2 },
      { opacity: 1, y: 0, rotateZ: 0, duration: 1.0 }, 0.15);
    if (typeof Splitting !== 'undefined') {
      const en = Splitting({ target: '#stooge-en', by: 'chars' });
      tl.fromTo('#stooge-en .char', { opacity: 0, y: 22, filter: 'blur(6px)' },
        { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.7, stagger: 0.028 }, 0.6);
    } else {
      tl.fromTo('#stooge-en', { opacity: 0 }, { opacity: 1, duration: 0.8 }, 0.6);
    }
    tl.fromTo('#stooge-hero .hero-by', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6 }, 0.9);
    tl.fromTo('#stooge-hero .hero-cta', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.6 }, 1.0);
  }

  /* GSAP 滚动光效：随鼠标在展厅浮动一道晕光 */
  function initAura() {
    if (typeof gsap === 'undefined') return;
    const div = document.createElement('div');
    div.className = 'g-aura';
    div.style.cssText = 'position:fixed;width:520px;height:520px;border-radius:50%;pointer-events:none;z-index:5;opacity:0;transform:translate(-50%,-50%);mix-blend-mode:screen;background:radial-gradient(circle,rgba(255,75,31,.10),transparent 60%);will-change:left,top;';
    document.body.appendChild(div);
    const q = gsap.quickTo(div, 'left', { duration: .8, ease: 'power3' });
    const t = gsap.quickTo(div, 'top', { duration: .8, ease: 'power3' });
    const show = () => gsap.to(div, { opacity: 1, duration: .6 });
    const hide = () => gsap.to(div, { opacity: 0, duration: .8 });
    let moved = false;
    document.addEventListener('mousemove', e => {
      q(e.clientX); t(e.clientY);
      if (!moved) { moved = true; show(); }
    });
    document.addEventListener('mouseleave', () => { moved = false; hide(); });
  }

  /* 对弹窗内的元素做轻量 GSAP 入场（追加 .g-up 类） */
  function gsapUp(scope = document) {
    if (typeof gsap === 'undefined') return;
    scope.querySelectorAll('.g-up').forEach(el => gsap.fromTo(el, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: .5, ease: 'power3.out' }));
  }

  /* 重新观察新出现的 AOS 元素 */
  function refresh() {
    if (typeof AOS !== 'undefined') AOS.refresh();
  }

  /* 开放接口 */
  return {
    init: function () {
      gsapLoaded = false;
      initLenis();
      initAOS();
      initAura();
      /* 主视觉编排延迟到开场印记淡出后再播放 */
      const boot = document.getElementById('boot');
      const delay = boot && !boot.classList.contains('done') ? 1250 : 120;
      setTimeout(() => staggerHero(), delay);
    },
    scrollTo,
    gsapUp,
    refresh,
    get lenis() { return lenis; }
  };
})();

/* 页面级 ready 后初始化（等字体、等首屏） */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(() => BEAUTIFY.init(), 150));
} else {
  setTimeout(() => BEAUTIFY.init(), 150);
}

/* 锚点／按钮平滑滚动接管（Lenis 已接管 window 滚动，这里给 jQuery/非 Lenis 元素兜底） */
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-scroll-gallery]');
  if (btn) { e.preventDefault(); BEAUTIFY.scrollTo('#gallery'); }
}, true);