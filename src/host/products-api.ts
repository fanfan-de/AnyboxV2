import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProductsPort } from './applications/contracts.js'
import { failure, json, requestObject } from './http-utils.js'

/** Accepted application lifecycle work survives a browser disconnect. */
export async function handleProductsApi(products: ProductsPort, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (url.search) throw failure(400, 'invalid-input')
  const method = request.method ?? 'GET', path = url.pathname
  if (method === 'GET' && path === '/api/v1/products') { json(response, 200, products.list()); return }
  const match = /^\/api\/v1\/products\/([^/]+)(?:\/(open|stop|retry))?$/.exec(path)
  if (!match) throw failure(404, 'not-found')
  const id = decodeURIComponent(match[1]), action = match[2]
  if (method === 'GET' && !action) {
    const product = products.get(id)
    if (!product) throw failure(404, 'product-not-found')
    json(response, 200, product); return
  }
  if (method !== 'POST' || !action) throw failure(404, 'not-found')
  await requestObject(request, [])
  json(response, 200, await (action === 'open' ? products.open(id) : action === 'stop' ? products.disable(id) : products.retry(id)))
}
