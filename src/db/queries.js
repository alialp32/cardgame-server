'use strict';
const {pool}=require('./pool');

async function findUser(username){
 const [r]=await pool.query('SELECT * FROM users WHERE username=?',[username]);
 return r[0];
}

async function createUser(username,hash){
 const [r]=await pool.query('INSERT INTO users(username,pass_hash) VALUES(?,?)',[username,hash]);
 return r.insertId;
}

async function grantChips(userId,delta){
 await pool.query('UPDATE users SET chips_balance=chips_balance+? WHERE id=?',[delta,userId]);
}

module.exports={findUser,createUser,grantChips};