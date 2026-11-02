export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (window.conductor) {
    const response = await window.conductor.request(path, method, body);
    if (!response.ok) throw new Error(response.error ?? 'Request failed.');
    return response.value as T;
  }
  const response = await fetch('/api' + path, { method, headers: method !== 'GET' ? { 'content-type': 'application/json' } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let result: any; try { result = await response.json(); } catch { throw new Error('Conductor is unavailable. Check the local service.'); }
  if (!response.ok) throw new Error(result.error ?? 'Request failed.');
  return result as T;
}
