const U=process.env.CDEK_API_URL||"https://api.cdek.ru/v2";let tok;
async function token(){if(tok&&tok.exp>Date.now())return tok.v;
const r=await fetch(U+"/oauth/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"client_credentials",client_id:process.env.CDEK_CLIENT_ID,client_secret:process.env.CDEK_CLIENT_SECRET})});
const d=await r.json();if(!d.access_token)throw new Error("CDEK auth failed");tok={v:d.access_token,exp:Date.now()+(d.expires_in-60)*1000};return tok.v}
const call=async(p,o={})=>(await fetch(U+p,{...o,headers:{Authorization:"Bearer "+await token(),"Content-Type":"application/json"}})).json();
exports.cities=q=>call("/location/cities?country_codes=RU&size=8&city="+encodeURIComponent(q));
exports.pvz=c=>call("/deliverypoints?type=PVZ&city_code="+Number(c));
// 136 склад-склад (ПВЗ), 137 склад-дверь. Вес: допущение 700 г на изделие.
exports.tariff=async(to,door,n)=>{const d=await call("/calculator/tariff",{method:"POST",body:JSON.stringify({tariff_code:door?137:136,from_location:{code:Number(process.env.CDEK_FROM_CITY_CODE)},to_location:{code:Number(to)},packages:[{weight:700*Math.max(1,Math.min(10,Number(n)||1)),length:35,width:30,height:8}]})});
return d.total_sum!=null?{cost:Math.ceil(d.total_sum),min:d.period_min,max:d.period_max}:{cost:null}};
