/* ============================================================
   野性档案 SAVAGE ARCHIVE · mail.js
   邮件服务抽象层：EmailJS（主，免费 200 封/月）+ FormSubmit（备，免注册）
   配置保存在 localStorage，可在「安全设置」面板中修改
   ============================================================ */
'use strict';

const MAIL = {
  LS_KEY: 'sa_mail_config',

  /* 默认配置：未配置时使用 FormSubmit 免注册模式（需在设置中填写收件邮箱） */
  defaults: {
    provider: 'formsubmit',   // 'emailjs' | 'formsubmit'
    emailjs: { serviceId: '', templateId: '', publicKey: '' },
    formsubmit: { toEmail: '' }
  },

  load() {
    try {
      const c = JSON.parse(localStorage.getItem(MAIL.LS_KEY) || 'null');
      if (c && c.provider) return { ...MAIL.defaults, ...c, emailjs: { ...MAIL.defaults.emailjs, ...(c.emailjs || {}) }, formsubmit: { ...MAIL.defaults.formsubmit, ...(c.formsubmit || {}) } };
    } catch { }
    return { ...MAIL.defaults };
  },

  save(cfg) {
    localStorage.setItem(MAIL.LS_KEY, JSON.stringify(cfg));
  },

  /* 是否已配置可用 */
  ready(cfg = MAIL.load()) {
    if (cfg.provider === 'emailjs') {
      return !!(cfg.emailjs.serviceId && cfg.emailjs.templateId && cfg.emailjs.publicKey);
    }
    return !!cfg.formsubmit.toEmail;
  },

  /* 发送验证码邮件 */
  async sendCode(email, code) {
    const cfg = MAIL.load();
    if (cfg.provider === 'emailjs') {
      return MAIL._sendEmailJS(cfg, email, code);
    }
    return MAIL._sendFormSubmit(cfg, email, code);
  },

  /* EmailJS：浏览器直发，无需后端 */
  async _sendEmailJS(cfg, email, code) {
    if (typeof emailjs === 'undefined') {
      // 动态加载 SDK
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js';
        s.onload = res; s.onerror = () => rej(new Error('EmailJS SDK 加载失败'));
        document.head.appendChild(s);
      });
    }
    const { serviceId, templateId, publicKey } = cfg.emailjs;
    const res = await emailjs.send(serviceId, templateId, {
      to_email: email,
      to_name: email.split('@')[0],
      code: code,
      subject: '野性档案 · 邮箱验证码'
    }, { publicKey });
    if (res.status !== 200) throw new Error('EmailJS 发送失败');
    return true;
  },

  /* FormSubmit：免注册，POST 到 formsubmit.co/ajax/{email} */
  async _sendFormSubmit(cfg, email, code) {
    const to = cfg.formsubmit.toEmail;
    if (!to) throw new Error('未配置收件邮箱');
    const r = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(to)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        _subject: `野性档案 · 验证码 ${code}`,
        _template: 'table',
        '验证码': code,
        '收件邮箱': email,
        '用途': '邮箱验证码登录'
      })
    });
    const j = await r.json().catch(() => ({}));
    if (j.success !== 'true' && j.success !== true) throw new Error(j.message || 'FormSubmit 发送失败');
    return true;
  }
};
