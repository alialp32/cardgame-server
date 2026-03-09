'use strict';
const jwt=require('jsonwebtoken');
const {pool}=require('../db/pool');

module.exports=async function(req,res,next){
 try{
  const h=req.headers.authorization;
  if(!h) return res.status(401).json({ok:false,error:'no token'});
  const token=h.split(' ')[1];
  const data=jwt.verify(token,process.env.JWT_SECRET);
  const [r]=await pool.query('SELECT id,is_admin FROM users WHERE id=?',[data.id]);
  if(!r[0]) return res.status(401).json({ok:false});
  req.user=r[0];
  next();
 }catch(e){
  res.status(401).json({ok:false,error:'invalid token'});
 }
};
