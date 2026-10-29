// This browser preference contains no account or rehearsal information.
const DISMISSED_KEY = 'neeley-dress-rehearsal:welcome:v1';

export function installWelcomeTutorial({ document, window }) {
  const dialog = document.getElementById('welcome-dialog');
  const trigger = document.getElementById('welcome-open');
  const title = document.getElementById('welcome-title');
  const back = document.getElementById('welcome-back');
  const next = document.getElementById('welcome-next');
  const steps = [...dialog.querySelectorAll('[data-welcome-step]')];
  const progress = [...dialog.querySelectorAll('[data-welcome-progress]')];
  let step = 0;
  let returnFocus = trigger;

  function rememberDismissal() {
    try { window.localStorage.setItem(DISMISSED_KEY, 'dismissed'); }
    catch { /* The tutorial remains usable when browser storage is unavailable. */ }
  }

  function renderStep({ focus = true } = {}) {
    steps.forEach((panel, index) => { panel.hidden = index !== step; });
    progress.forEach((item, index) => {
      if (index === step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    back.hidden = step === 0;
    next.textContent = step === steps.length - 1 ? 'Got it' : 'Next →';
    if (focus) steps[step].querySelector('h3').focus({ preventScroll: true });
    dialog.querySelector('.welcome-content').scrollTop = 0;
    dialog.scrollTop = 0;
  }

  function open() {
    if (dialog.open || document.querySelector('dialog[open]')) return;
    returnFocus = document.activeElement === document.body ? trigger : document.activeElement;
    step = 0;
    dialog.querySelector('.welcome-scoring').open = false;
    renderStep({ focus: false });
    dialog.showModal();
    title.focus({ preventScroll: true });
  }

  function dismiss() {
    rememberDismissal();
    dialog.close();
  }

  trigger.addEventListener('click', open);
  document.getElementById('welcome-close').addEventListener('click', dismiss);
  document.getElementById('welcome-skip').addEventListener('click', dismiss);
  back.addEventListener('click', () => { if (step > 0) { step--; renderStep(); } });
  next.addEventListener('click', () => {
    if (step === steps.length - 1) dismiss();
    else { step++; renderStep(); }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('close', () => {
    rememberDismissal();
    (returnFocus?.isConnected ? returnFocus : trigger).focus({ preventScroll: true });
  });

  let dismissed = false;
  try { dismissed = window.localStorage.getItem(DISMISSED_KEY) === 'dismissed'; }
  catch { /* Without storage, show the guide once in this loaded page. */ }
  if (!dismissed) open();
}
