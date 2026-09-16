// Local deterministic provider for protocol tests; makes no model/network calls.
export default function(pi) {
  pi.registerProvider('eval-protocol-test',{
    baseUrl:'https://example.invalid',apiKey:'local-placeholder',api:'eval-protocol-test',
    models:[{id:'deterministic',name:'Offline protocol test',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:1000}],
    streamSimple(model,context){
      const tool=context.messages.find(m=>m.role==='toolResult');
      const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:tool?'stop':'toolUse',content:tool?[{type:'text',text:JSON.stringify({observedIsError:tool.isError,content:tool.content})}]:[{type:'toolCall',id:'protocol-call',name:'mcp__api__get',arguments:{}}]};
      return {async *[Symbol.asyncIterator](){yield {type:'start',partial:message};yield {type:'done',reason:message.stopReason,message};},result:async()=>message};
    }
  });
}
