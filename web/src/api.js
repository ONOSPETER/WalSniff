export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-walsniff': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch { throw Object.assign(new Error('Cannot reach the server. Check your connection and try again.'), { status: 0 }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}
