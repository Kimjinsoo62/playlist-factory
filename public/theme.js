// 다크/라이트 모드: <head> 에서 먼저 실행해 첫 그림부터 저장된 테마로 그린다(깜빡임 방지).
// 선택은 localStorage 'pf.theme' 에 저장되며, 메인 창·로그 창이 storage 이벤트로 서로 동기화된다. 기본은 다크.
(() => {
  const KEY = 'pf.theme';
  const read = () => { try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } };
  const apply = (t) => {
    document.documentElement.dataset.theme = t;
    for (const b of document.querySelectorAll('#btnTheme')) { b.textContent = t === 'dark' ? '🌙' : '☀'; b.title = t === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'; }
  };
  try { const q = new URLSearchParams(location.search).get('theme'); if (q === 'light' || q === 'dark') localStorage.setItem(KEY, q); } catch {}   // ?theme=light|dark 로 지정(캡처·링크용)
  apply(read());
  document.addEventListener('DOMContentLoaded', () => {
    apply(read());
    for (const b of document.querySelectorAll('#btnTheme')) b.onclick = () => {
      const t = read() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, t); } catch {}
      apply(t);
    };
  });
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(read()); });   // 다른 창에서 바꾼 경우
})();
