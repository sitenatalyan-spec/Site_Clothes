const C=require("./catalog"),cdek=require("../lib/cdek"),crypto=require("crypto");
const j=(s,b)=>({statusCode:s,headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});
exports.handler=async e=>{
if(e.httpMethod!=="POST")return j(405,{error:"Method"});
let b;try{b=JSON.parse(e.body)}catch{return j(400,{error:"Bad JSON"})}
const {items,contact:c={},delivery:d={}}=b;
if(!Array.isArray(items)||!items.length||items.length>30)return j(400,{error:"Пустая корзина"});
const name=String(c.name||"").trim().slice(0,100),phone=String(c.phone||"").replace(/[^\d+]/g,""),email=String(c.email||"").trim().slice(0,120);
if(!name||phone.replace(/\D/g,"").length<10||!/^\S+@\S+\.\S+$/.test(email))return j(400,{error:"Проверьте контактные данные"});
const door=d.type==="cdek_door";
if(!d.city_code||!["cdek_pvz","cdek_door"].includes(d.type)||(door?String(d.address||"").length<5:!d.pvz))return j(400,{error:"Проверьте данные доставки"});
let sum=0,n=0;const receipt=[];
for(const i of items){const p=C[i.id],q=Math.floor(Number(i.q));
if(!p||!p.s.includes(i.size)||!(q>0&&q<=10))return j(400,{error:"Некорректный товар в корзине"});
sum+=p.p*q;n+=q;receipt.push({description:`${p.n}, ${i.size}`.slice(0,128),quantity:String(q),amount:{value:p.p.toFixed(2),currency:"RUB"},vat_code:1,payment_mode:"full_payment",payment_subject:"commodity"})}
let t;try{t=await cdek.tariff(d.city_code,door,n)}catch{return j(502,{error:"Не удалось рассчитать доставку"})}
if(t.cost==null)return j(400,{error:"Доставка в этот город недоступна"});
receipt.push({description:"Доставка СДЭК",quantity:"1",amount:{value:t.cost.toFixed(2),currency:"RUB"},vat_code:1,payment_mode:"full_payment",payment_subject:"service"});
const total=sum+t.cost,orderId="GN-"+Date.now().toString(36).toUpperCase();
const auth=Buffer.from(process.env.YOOKASSA_SHOP_ID+":"+process.env.YOOKASSA_SECRET_KEY).toString("base64");
const r=await fetch("https://api.yookassa.ru/v3/payments",{method:"POST",headers:{Authorization:"Basic "+auth,"Idempotence-Key":crypto.randomUUID(),"Content-Type":"application/json"},
body:JSON.stringify({amount:{value:total.toFixed(2),currency:"RUB"},capture:true,confirmation:{type:"redirect",return_url:process.env.SITE_URL+"/#/order-ok"},description:"Заказ "+orderId,
receipt:{customer:{full_name:name,phone,email},items:receipt},
metadata:{order_id:orderId,name,phone,email,delivery:d.type,city:String(d.city||"").slice(0,100),pvz:String(d.pvz||"").slice(0,50),address:String(d.address||"").slice(0,200),subscribe:b.subscribe?"yes":"no"}})});
const p=await r.json();
if(!p.confirmation||!p.confirmation.confirmation_url)return j(502,{error:"Платёжный сервис отклонил запрос"});
return j(200,{order_id:orderId,total,confirmation_url:p.confirmation.confirmation_url})};
