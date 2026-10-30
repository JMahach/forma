import type {AccountChart,ChartWriteIntent} from '../../shared/chart-record-contract.ts';
import type {BirthSubmission} from '../domain/chart-record.ts';
import type {ChartActions,ChartActionResult} from '../state/chart-actions.ts';
import type {LibrarySession} from '../state/account-library.ts';

interface EditingObservation {
 finishSuccess():unknown;
 reportError(error:unknown,step:{stage:'commit'|'request'}):unknown;
 reportFailure(step:{stage:'response';reason:'outcome_unknown';outcome:'unknown'}):unknown;
}
interface EditingPorts {
 actions:Pick<ChartActions,'create'|'update'|'recover'|'remove'>;
 ready():Promise<void>;
 session():LibrarySession|null;
 accountId():string|null;
 temporaryId():string|null;
 observe?(action:'chart_save'|'chart_delete'):EditingObservation|undefined;
 durable():boolean;
 online():boolean;
 deleted(id:string):void;
 messages:{signIn:string;failed:string;unconfirmed:string;unavailable:string};
}
type SubmissionResult={id:string;persisted:boolean;metadataOnly:boolean};
type RemovalResult={kind:'deleted'|'unknown'|'inactive'|'rejected';error?:unknown};
const failure=(code:string,message:string)=>Object.assign(new Error(message),{code});
const sameSession=(a:LibrarySession|null,b:LibrarySession)=>a?.accountId===b.accountId && a?.sessionId===b.sessionId;

/** Own the form's uncertain command; server facts remain owned by ChartActions. */
class ChartEditing {
 private ports:EditingPorts;
 private intent:ChartWriteIntent|null=null;
 private generation=0;
 constructor(ports:EditingPorts){this.ports=ports;}
 get checking(){return this.intent!==null;}
 reset(){this.generation++;this.intent=null;}
 private result(id:string,metadataOnly:boolean):SubmissionResult{return {id,persisted:this.ports.durable(),metadataOnly};}
 private patch(input:BirthSubmission,access:LibrarySession) {
  const previous=input.previous! as NonNullable<BirthSubmission['previous']> & Partial<AccountChart>;
  if(previous.accountId!==access.accountId || !previous.noteRevision)throw failure('auth_required',this.ports.messages.signIn);
  const name=previous.name===input.name?{}:{name:input.name};
  const note=previous.note===input.note?{}:{note:{value:input.note,seenRevision:previous.noteRevision}};
  if(!input.birth && !Object.keys(name).length && !Object.keys(note).length)return null;
  return {chartId:previous.id,...name,...note,...(input.birth?{birth:input.birth}:{})};
 }
 private async request(input:BirthSubmission,access:LibrarySession,signal:AbortSignal):Promise<ChartActionResult|SubmissionResult> {
  if(this.intent)return this.ports.actions.recover(this.intent,signal);
  if(input.previous){
   const patch=this.patch(input,access);
   return patch?this.ports.actions.update(patch,signal):this.result(input.previous.id,true);
  }
  if(!input.birth)throw failure('invalid_request',this.ports.messages.failed);
  return this.ports.actions.create({name:input.name,note:input.note,birth:input.birth},signal);
 }
 private finish(result:ChartActionResult,input:BirthSubmission):SubmissionResult {
  if(result.kind==='unknown'){
   this.intent=result.intent;throw failure('write_unknown',this.ports.messages.unconfirmed);
  }
  if(!result.active)throw failure('account_changed',this.ports.messages.signIn);
  if(result.receipt.outcome.kind==='rejected')throw failure(result.receipt.outcome.code,this.ports.messages.failed);
  if(!result.chart){
   this.intent={operationId:result.receipt.operationId,expectedAccountId:result.receipt.expectedAccountId};
   throw failure('chart_unavailable',this.ports.messages.unavailable);
  }
  this.intent=null;return this.result(result.chart.id,Boolean(input.previous && !input.birth));
 }
 submit(input:BirthSubmission,signal:AbortSignal):Promise<SubmissionResult>|null {
  if(input.previous && input.previous.id===this.ports.temporaryId())return null;
  if(!this.ports.session() && !this.ports.accountId())return null;
  const observation=this.ports.observe?.('chart_save');
  return this.submitAccount(input,signal).then(result=>{observation?.finishSuccess();return result;},error=>{
   void observation?.reportError(error,{stage:'commit'});throw error;
  });
 }
 private async submitAccount(input:BirthSubmission,signal:AbortSignal):Promise<SubmissionResult> {
  const access=this.ports.session(),generation=this.generation;
  await this.ports.ready();signal.throwIfAborted();
  if(!access || !sameSession(this.ports.session(),access) || generation!==this.generation)
   throw failure('account_changed',this.ports.messages.signIn);
  const result=await this.request(input,access,signal);
  if(signal.aborted || generation!==this.generation)throw failure('account_changed',this.ports.messages.signIn);
  return 'kind' in result?this.finish(result,input):result;
 }
 private async recoverRemoval(result:ChartActionResult,signal:AbortSignal,active:()=>boolean):Promise<ChartActionResult|RemovalResult> {
  if(result.kind!=='unknown' || !this.ports.online())return result;
  try{return await this.ports.actions.recover(result.intent,signal);}
  catch(error){return active()?{kind:'unknown',error}:{kind:'inactive'};}
 }
 async remove(id:string,signal:AbortSignal):Promise<RemovalResult> {
  const observation=this.ports.observe?.('chart_delete');
  try {
   const result=await this.removeAccount(id,signal);
   if(result.kind==='unknown')void observation?.reportFailure({stage:'response',reason:'outcome_unknown',outcome:'unknown'});
   else observation?.finishSuccess();
   return result;
  }catch(error){void observation?.reportError(error,{stage:'request'});throw error;}
 }
 private async removeAccount(id:string,signal:AbortSignal):Promise<RemovalResult> {
  const access=this.ports.session();if(!access)return {kind:'inactive'};
  const active=()=>!signal.aborted && sameSession(this.ports.session(),access);
  const result=await this.ports.actions.remove(id,signal);if(!active())return {kind:'inactive'};
  // Only receipt recovery may follow an uncertain delete; never repeat DELETE.
  const settled=await this.recoverRemoval(result,signal,active);if(!active())return {kind:'inactive'};
  if(settled.kind==='unknown')return {kind:'unknown',error:settled.error};
  if(settled.kind!=='settled' || !settled.active)return {kind:'inactive'};
  return this.finishRemoval(id,settled);
 }
 private finishRemoval(id:string,result:Extract<ChartActionResult,{kind:'settled'}>):RemovalResult {
  const deleted=!result.chart && !result.readError
   && (result.receipt.outcome.kind==='deleted' || result.receipt.outcome.kind==='absent');
  if(deleted)this.ports.deleted(id);
  return {kind:deleted?'deleted':'rejected'};
 }
}

export function createChartEditing(ports:EditingPorts) {
 const owner=new ChartEditing(ports);
 return {submit:owner.submit.bind(owner),remove:owner.remove.bind(owner),reset:owner.reset.bind(owner),get checking(){return owner.checking;}};
}
