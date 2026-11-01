try {
  var t = localStorage.getItem('ws-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = t;
} catch (e) {}
