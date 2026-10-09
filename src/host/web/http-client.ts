export async function requestJSON<T>(url: string, body?: object, signal?: AbortSignal, headers?: Readonly<Record<string, string>>): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw Object.assign(new Error(data?.error?.code ?? 'request-failed'), { status: response.status, code: data?.error?.code ?? 'request-failed', ...(data?.error?.fileIndex === undefined ? {} : { fileIndex: data.error.fileIndex }) })
  return data as T
}
