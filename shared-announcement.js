/* Shared homepage announcement. No access to attendance data, auth or queues. */
(function (root) {
  'use strict';
  function decode(fields, now) {
    if (fields && fields.published && fields.published.booleanValue === false) return null;
    if (!fields || !fields.published || fields.published.booleanValue !== true || !fields.text || !fields.level || !fields.expiresAt) throw Error('invalid');
    var text = fields.text.stringValue, level = fields.level.stringValue, expiry = Date.parse(fields.expiresAt.timestampValue);
    if (typeof text !== 'string' || !text.trim() || text.length > 1000 || ['normal','important','urgent'].indexOf(level) < 0 || !isFinite(expiry)) throw Error('invalid');
    return expiry <= now ? null : {text:text, level:level, expiresAt:expiry};
  }
  function createTransport(options) {
    var base = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(options.projectId) + '/databases/(default)/documents/';
    function request(path, method, token, body) {
      var headers = body ? {'Content-Type':'application/json'} : {};
      if (token) headers.Authorization = 'Bearer ' + token;
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer;
      return new Promise(function (resolve,reject) {
        timer = setTimeout(function () { if(controller) controller.abort(); reject(Error('unconfirmed')); },15000);
        options.fetch(base + path, {method:method,headers:headers,cache:'no-store',credentials:'omit',body:body ? JSON.stringify(body) : undefined,signal:controller ? controller.signal : undefined}).then(function(response) {
          if (response.status === 404 && method === 'GET') return null;
          if (!response.ok) throw Error(response.status === 409 || response.status === 412 ? 'conflict' : response.status === 401 || response.status === 403 ? 'forbidden' : 'unavailable');
          return response.json();
        }).then(resolve,reject);
      }).then(function(value){clearTimeout(timer);return value;},function(error){clearTimeout(timer);throw error;});
    }
    return {
      read:function () { return request('publicAnnouncements/current','GET').then(function(doc){return {notice:doc ? decode(doc.fields,Date.now()) : null,version:doc ? doc.updateTime : null};}); },
      role:function(uid,token) {return request('announcementAdmins/'+encodeURIComponent(uid),'GET',token).then(function(doc){return !!(doc && doc.fields && doc.fields.active && doc.fields.active.booleanValue === true);});},
      write:function(fields,token,version) {
        var condition=version ? 'currentDocument.updateTime='+encodeURIComponent(version) : 'currentDocument.exists=false';
        return request('publicAnnouncements/current?'+condition,'PATCH',token,{fields:fields});
      }
    };
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports={decode:decode,createTransport:createTransport}; return; }
  function start() {
    if (!root.fetch || typeof FIREBASE_CONFIG === 'undefined') return;
    var transport=createTransport({projectId:FIREBASE_CONFIG.projectId,fetch:root.fetch.bind(root)});
    var cacheKey='dys_shared_announcement_v1', notice=null,version=null,draftVersion=null,loaded=false,offline=true,readFailed=false,busy=false,dirty=false,auth=null,lastRead=0,reading=null;
    var $=function(id){return document.getElementById(id);};
    function status(message){var el=$('announcement-status');if(el)el.textContent=message;}
    function controls(value){busy=value;['announcement-publish','announcement-withdraw','announcement-login','announcement-logout'].forEach(function(id){if($(id))$(id).disabled=value;});}
    function render() {
      var bar=$('announce-bar'),toggle=$('announcement-toggle'); if(!bar||!toggle)return;
      var open=bar.classList.contains('show');
      bar.style.display='';toggle.style.display='';bar.className='announce-bar';toggle.className='announcement-toggle show';
      var current=notice&&notice.expiresAt>Date.now()?notice:null;
      if(current&&current.level!=='normal')bar.classList.add('level-'+current.level);
      if(current&&current.level==='urgent')toggle.classList.add('urgent');
      var span=bar.querySelector('.announce-text')||document.createElement('span');span.className='announce-text';
      span.textContent=current?'📢 系統公告'+(offline?'（離線副本）':'')+'：'+current.text:readFailed?'公告暫時無法載入，請稍後再試。':loaded?'目前沒有公告。':'公告載入中，請稍候。';
      var close=bar.querySelector('.announce-dismiss')||document.createElement('button');close.type='button';close.className='announce-dismiss';close.textContent='✕';close.setAttribute('aria-label','收合公告');close.onclick=function(){bar.classList.remove('show');toggle.setAttribute('aria-expanded','false');toggle.focus();};
      if(!span.parentNode)bar.appendChild(span);if(!close.parentNode)bar.appendChild(close);if(open)bar.classList.add('show');toggle.setAttribute('aria-expanded',String(open));
    }
    function fillDraft(){
      if(dirty||!loaded)return;
      $('s-announcement').value=notice?notice.text:'';$('s-announcement-level').value=notice?notice.level:'normal';
      var d=notice?new Date(notice.expiresAt-1):null;
      $('s-announcement-expiry').value=d&&d.getFullYear()<9999?d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2):'';
    }
    function refresh(force){
      if(reading)return reading;
      if(!force&&Date.now()-lastRead<120000){render();return Promise.resolve();}
      lastRead=Date.now();
      reading=transport.read().then(function(result){notice=result.notice;version=result.version;loaded=true;offline=false;readFailed=false;try{localStorage.setItem(cacheKey,JSON.stringify(notice));}catch(_){}render();fillDraft();return result;},function(error){offline=true;readFailed=true;render();throw error;}).then(function(result){reading=null;return result;},function(error){reading=null;throw error;});
      return reading;
    }
    function getAuth(){
      if(auth)return auth;
      if(!root.firebase||!root.firebase.auth)throw Error('unavailable');
      var name='dys-announcement-publisher',app=root.firebase.apps.filter(function(a){return a.name===name;})[0];
      if(app&&app.options.projectId!==FIREBASE_CONFIG.projectId)throw Error('invalid');
      if(!app)app=root.firebase.initializeApp(FIREBASE_CONFIG,name);
      auth=app.auth();return auth;
    }
    function signIn(){
      if(busy)return;
      controls(true);status('正在確認公告發布權限…');
      var email=$('announcement-email').value.trim(),password=$('announcement-password').value;
      Promise.resolve().then(function(){var a=getAuth();return a.setPersistence(root.firebase.auth.Auth.Persistence.SESSION).then(function(){return a.signInWithEmailAndPassword(email,password);});}).then(function(result){$('announcement-password').value='';return result.user.getIdToken().then(function(token){return transport.role(result.user.uid,token);});}).then(function(allowed){if(!allowed)throw Error('forbidden');status('公告管理員已登入，可以發布給所有同仁。');},function(){status('無法登入或沒有公告發布權限，請確認帳號密碼。');if(auth)auth.signOut().catch(function(){});}).then(function(){controls(false);});
    }
    function signOut(){try{getAuth().signOut().then(function(){status('公告管理員已登出。');},function(){status('登出未完成，請再試一次。');});}catch(_){status('公告管理員尚未登入。');}}
    function publish(withdraw){
      if(busy)return;
      var text=$('s-announcement').value.trim(),level=$('s-announcement-level').value,date=$('s-announcement-expiry').value;
      var expires=date?new Date(date+'T00:00:00'):new Date('9999-12-31T00:00:00Z');if(date)expires.setDate(expires.getDate()+1);
      if(!withdraw&&(!text||text.length>1000||!isFinite(expires.getTime())||expires.getTime()<=Date.now())){status('請填寫 1～1000 字公告及有效到期日。');return;}
      if(withdraw&&!root.confirm('確定撤回所有同仁看到的公告？離線裝置連線後會更新。'))return;
      var user;try{user=getAuth().currentUser;}catch(_){}
      if(!user){status('請先登入公告管理員帳號。內容已保留。');return;}
      controls(true);status('正在送出，請等待雲端確認…');
      var expectedVersion=dirty?draftVersion:version;
      // Read immediately before writing and use updateTime to reject competing publishers.
      refresh(true).then(function(){if(version!==expectedVersion)throw Error('conflict');return user.getIdToken();}).then(function(token){
        return transport.write(withdraw?{published:{booleanValue:false}}:{published:{booleanValue:true},text:{stringValue:text},level:{stringValue:level},expiresAt:{timestampValue:expires.toISOString()}},token,version);
      }).then(function(doc){
        notice=decode(doc.fields,Date.now());version=doc.updateTime;loaded=true;offline=false;dirty=false;
        try{localStorage.setItem(cacheKey,JSON.stringify(notice));}catch(_){}render();fillDraft();
        status(withdraw?'已撤回。連線中的同仁最遲兩分鐘內更新。':'已發布給所有同仁。連線中的裝置最遲兩分鐘內更新。');
      },function(error){status(error.message==='conflict'?'公告已被其他管理員更新，本次未覆蓋，輸入已保留。':error.message==='forbidden'?'發布被拒絕，請重新確認公告管理員權限。輸入已保留。':'尚未確認發布結果。請先重新讀取公告確認，輸入已保留。');}).then(function(){controls(false);});
    }
    try{var saved=JSON.parse(localStorage.getItem(cacheKey)||'null');if(saved)notice=decode({published:{booleanValue:true},text:{stringValue:saved.text},level:{stringValue:saved.level},expiresAt:{timestampValue:new Date(saved.expiresAt).toISOString()}},Date.now());}catch(_){}
    root.DysAnnouncement={render:render,fillDraft:fillDraft,refresh:refresh,signOut:signOut};
    ['s-announcement','s-announcement-level','s-announcement-expiry'].forEach(function(id){$(id).addEventListener('input',function(){if(!dirty)draftVersion=version;dirty=true;});});
    $('announcement-login').onclick=signIn;$('announcement-logout').onclick=signOut;
    $('announcement-publish').onclick=function(){publish(false);};$('announcement-withdraw').onclick=function(){publish(true);};
    $('announcement-refresh').onclick=function(){refresh(true).then(function(){draftVersion=version;status('已讀取最新公告，草稿已保留。再次發布將以此版本為準。');},function(){status('暫時讀不到公告，請稍後再試。');});};
    root.addEventListener('focus',function(){refresh(false).catch(function(){});});
    root.addEventListener('online',function(){refresh(true).catch(function(){});});
    root.setInterval(function(){render();if(!document.hidden)refresh(false).catch(function(){});},120000);
    render();refresh(true).catch(function(){status('暫時讀不到共用公告，打卡仍可使用。');});
  }
  // Optional module failure must never stop the existing attendance startup.
  try{start();}catch(_){var el=document.getElementById('announcement-status');if(el)el.textContent='公告暫時無法使用，打卡仍可使用。';}
})(typeof window!=='undefined'?window:this);
