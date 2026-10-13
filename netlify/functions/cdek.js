const c=require("../lib/cdek");
const j=(s,b)=>({statusCode:s,headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});
exports.handler=async e=>{const q=e.queryStringParameters||{};
try{if(q.action==="cities")return j(200,await c.cities(String(q.q||"").slice(0,60)));
if(q.action==="pvz"){const r=await c.pvz(q.city);return j(200,(Array.isArray(r)?r:[]).map(x=>({code:x.code,name:x.name||"",address:(x.location&&x.location.address)||"",metro:x.nearest_metro_station||"",work:x.work_time||"",fit:!!x.is_dressing_room})))}
if(q.action==="tariff")return j(200,await c.tariff(q.to,q.door==="1",q.n));
return j(400,{error:"action"})}catch(err){return j(502,{error:"CDEK недоступен"})}};
