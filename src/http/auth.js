'use strict';
const bcrypt=require('bcrypt');
const jwt=require('jsonwebtoken');
const express=require('express');
const {findUser,createUser}=require('../db/queries');
const router=express.Router();

router.post('/register',async(req,res)=>{
 const {u,p}=req.body;
 if(!u||!p)return res.json({ok:false});
 const hash=await bcrypt.hash(p,10);
 const id=await createUser(u,hash);
 res.json({ok:true,id});
});

router.post('/login',async(req,res)=>{
 const {u,p}=req.body;
 const user=await findUser(u);
 if(!user)return res.json({ok:false});
 const ok=await bcrypt.compare(p,user.pass_hash);
 if(!ok)return res.json({ok:false});
 const token=jwt.sign({id:user.id},process.env.JWT_SECRET);
 res.json({ok:true,token});
});

module.exports=router;