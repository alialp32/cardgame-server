'use strict';
function ok(res, data){res.json({ok:true,...data});}
function fail(res, msg){res.status(400).json({ok:false,error:msg});}
module.exports={ok,fail};