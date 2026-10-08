// Публичные значения Supabase. Секретные ключи (sb_secret_*, service_role) сюда попасть не должны.
const secret=k=>{if(/^sb_secret_/.test(k))return true;try{return JSON.parse(Buffer.from(k.split(".")[1],"base64").toString()).role==="service_role"}catch{return false}};
exports.handler=async()=>{
  const url=process.env.SUPABASE_URL||"",key=process.env.SUPABASE_ANON_KEY||"";
  const h={"Content-Type":"application/json"};
  if(secret(key))return{statusCode:500,headers:h,body:JSON.stringify({error:"В SUPABASE_ANON_KEY указан секретный ключ. Нужен publishable / anon."})};
  if(!/^https:\/\/.+\.supabase\.co\/?$/.test(url))return{statusCode:500,headers:h,body:JSON.stringify({error:"SUPABASE_URL должен быть вида https://xxxx.supabase.co"})};
  return{statusCode:200,headers:{...h,"Cache-Control":"public,max-age=300"},body:JSON.stringify({url,key})};
};
