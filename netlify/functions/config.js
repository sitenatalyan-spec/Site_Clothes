// Публичные значения Supabase (anon key публичный по назначению; service_role сюда НЕ добавлять)
exports.handler=async()=>({statusCode:200,headers:{"Content-Type":"application/json","Cache-Control":"public,max-age=300"},body:JSON.stringify({url:process.env.SUPABASE_URL,key:process.env.SUPABASE_ANON_KEY})});
