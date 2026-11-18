import { deleteDoc, DodoError, movePath, readDoc, setProjects, writeDoc } from '@/core'
import { errorResponse, getState, jsonBody, pathParam, refresh } from '@/server/state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  try {
    return Response.json(await readDoc((await getState()).db, pathParam(req)))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PUT(req: Request): Promise<Response> {
  try {
    const state = await getState()
    const result = await writeDoc(
      state.db,
      pathParam(req),
      await jsonBody(req, { body: 'string', baseHash: 'string', clientId: 'string?', onConflict: 'string?' }),
    )
    await refresh(state)
    return Response.json(result)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    const state = await getState()
    const path = pathParam(req)
    const input = await jsonBody<{ moveTo?: string; projects?: string[] }>(req, { moveTo: 'string?', projects: 'string[]?' })
    let out: unknown
    if (input.moveTo !== undefined) out = { paths: await movePath(state.db, path, input.moveTo) }
    else if (input.projects) out = await setProjects(state.db, path, input.projects)
    else throw new DodoError('usage', 'expected { moveTo } or { projects }')
    await refresh(state)
    return Response.json(out)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const state = await getState()
    await deleteDoc(state.db, pathParam(req))
    await refresh(state)
    return Response.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
