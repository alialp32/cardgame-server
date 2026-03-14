'use strict';
const {pool}=require('./pool');

async function findUser(username){
 const [r]=await pool.query('SELECT * FROM users WHERE username=?',[username]);
 return r[0] || null;
}

async function findUserById(userId){
 const [r]=await pool.query('SELECT * FROM users WHERE id=? LIMIT 1',[userId]);
 return r[0] || null;
}

async function findUserByEmail(email){
 const normalized = String(email || '').trim().toLowerCase();
 if (!normalized) return null;
 const [r]=await pool.query('SELECT * FROM users WHERE LOWER(email)=? LIMIT 1',[normalized]);
 return r[0] || null;
}

async function findUserByGoogleSub(googleSub){
 const normalized = String(googleSub || '').trim();
 if (!normalized) return null;
 const [r]=await pool.query('SELECT * FROM users WHERE google_sub=? LIMIT 1',[normalized]);
 return r[0] || null;
}

async function createUser(username,hash){
 const [r]=await pool.query('INSERT INTO users(username,pass_hash) VALUES(?,?)',[username,hash]);
 return r.insertId;
}

async function grantChips(userId,delta){
 await pool.query('UPDATE users SET chips_balance=chips_balance+? WHERE id=?',[delta,userId]);
}

module.exports={findUser,findUserById,findUserByEmail,findUserByGoogleSub,createUser,grantChips};
