// Supabase "Send SMS Hook" (HTTPS) -> SMS.ru
const crypto=require("crypto");
const out=(s,b)=>({statusCode:s,headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});
const fail=(s,m)=>out(s,{error:{http_code:s,message:m}});
function verify(e){
  const h=Object.fromEntries(Object.entries(e.headers||{}).map(([k,v])=>[k.toLowerCase(),v]));
  const id=h["webhook-id"],ts=h["webhook-timestamp"],sig=h["webhook-signature"];
  if(!id||!ts||!sig||Math.abs(Date.now()/1000-Number(ts))>300)return false;
  const key=Buffer.from(String(process.env.SEND_SMS_HOOK_SECRET||"").replace(/^v1,whsec_/,""),"base64");
  const exp=crypto.createHmac("sha256",key).update(`${id}.${ts}.${e.body}`).digest("base64");
  return sig.split(" ").some(p=>{const v=p.replace(/^v1,/,"");return v.length===exp.length&&crypto.timingSafeEqual(Buffer.from(v),Buffer.from(exp))});
}
exports.handler=async e=>{
  if(e.httpMethod!=="POST")return fail(405,"Method not allowed");
  if(!verify(e))return fail(401,"Invalid signature");
  let b;try{b=JSON.parse(e.body)}catch{return fail(400,"Bad JSON")}
  const phone=String((b.user&&b.user.phone)||"").replace(/\D/g,""),otp=String((b.sms&&b.sms.otp)||"");
  if(phone.length!==11||!/^\d{4,8}$/.test(otp))return fail(400,"Bad payload");
  const p=new URLSearchParams({api_id:process.env.SMSRU_API_ID,to:phone,msg:`Gluhova Natalya: код ${otp}. Никому не сообщайте.`,json:"1"});
  if(process.env.SMSRU_FROM)p.set("from",process.env.SMSRU_FROM);
  if(process.env.SMSRU_TEST==="1")p.set("test","1");
  try{
    const r=await fetch("https://sms.ru/sms/send",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:p});
    const d=await r.json();
    const item=d.sms&&d.sms[phone];
    if(d.status==="OK"&&item&&item.status==="OK")return out(200,{});
    return fail(502,"SMS.ru: "+((item&&item.status_text)||d.status_text||"ошибка"));
  }catch{return fail(502,"SMS.ru недоступен")}
};
