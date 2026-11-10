import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
const h = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), token: false, authenticated: true }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req,res,next) => {
  if (!h.authenticated) return res.status(401).json({error:'Not authenticated'});
  req.session={userId:'owner'}; req.apiToken=h.token; next();
} }));
vi.mock('../services/signatureLibrary.js', async original => ({ ...(await original()), getSignatureLibrary:h.get, saveSignatureLibrary:h.save }));
import express from 'express';
import routes from './signatures.js';
import { SignatureError } from '../services/signatureLibrary.js';
describe('signature routes',()=>{
  let server,base;
  beforeAll(async()=>{const app=express();app.use(express.json());app.use('/api/signatures',routes);await new Promise(resolve=>{server=app.listen(0,resolve);});base=`http://127.0.0.1:${server.address().port}/api/signatures/account`;});
  afterAll(async()=>{await new Promise(resolve=>server.close(resolve));});
  beforeEach(()=>{h.get.mockReset();h.save.mockReset();h.token=false;h.authenticated=true;});
  it('passes the authenticated owner and exact account to reads and atomic saves',async()=>{
    h.get.mockResolvedValue({signatures:[]});expect((await fetch(base)).status).toBe(200);expect(h.get).toHaveBeenCalledWith('owner','account');
    const body={revision:'1',signatures:[],defaults:[]};h.save.mockResolvedValue({...body,revision:'2'});
    const response=await fetch(base,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    expect(response.status).toBe(200);expect(h.save).toHaveBeenCalledWith('owner','account',body);
  });
  it('denies unauthenticated and API-token clients before touching content',async()=>{
    h.authenticated=false;expect((await fetch(base)).status).toBe(401);h.authenticated=true;h.token=true;
    expect((await fetch(base)).status).toBe(403);expect((await fetch(base,{method:'PUT',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(403);
    expect(h.get).not.toHaveBeenCalled();expect(h.save).not.toHaveBeenCalled();
  });
  it('returns explicit revision conflicts and ownership errors',async()=>{
    h.get.mockRejectedValue(new SignatureError(404,'Account not found'));expect((await fetch(base)).status).toBe(404);
    h.save.mockRejectedValue(new SignatureError(409,'Reload signatures','signature_revision_conflict'));
    const response=await fetch(base,{method:'PUT',headers:{'content-type':'application/json'},body:'{}'});
    expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'Reload signatures',code:'signature_revision_conflict'});
  });
});
