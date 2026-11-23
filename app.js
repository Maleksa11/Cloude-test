(function(){
  var $=function(i){return document.getElementById(i)};
  var L={
    en:{sub:'Paste a link to start, or search YouTube.',privacy:'Privacy and storage',privacyText:'Your watch history and interests are stored in this browser only and are not encrypted by the app. Search, metadata, and thumbnail requests are relayed through Cloudflare; the YouTube player still connects directly from your device. Cloudflare and YouTube can see your connection IP. There is no account system or shared server-side history in this version. Anyone using the same browser profile can see that profile’s local history.',searchPh:'Search YouTube...',searchBtn:'Search',orLink:'Or paste a video / playlist link',searching:'Searching YouTube...',loadingSuggest:'Loading suggestions...',noResults:'No videos found.',searchFail:'Search is temporarily unavailable. Try again or paste a link.',paste:'Paste & play',go:'Start',ph:'Paste link here',
      tip:'To open it like an app: on iPhone, tap Share in Safari, then “Add to Home Screen”. On Android, tap ⋮ then “Add to Home screen”.',
      videos:'Videos',playlistTab:'My list',recommendTab:'Recommended',recWait:'Loading recommendations for this video…',recFail:'Could not load recommendations right now.',recEmpty:'No recommendations found for this video.',noCurrent:'Play a video first to see recommendations.',audlbl:'Audio only mode',hint:'Swipe up for next • Double-tap left or right to skip',
      back:'Back',fit:'Fill / fit',aud2:'Audio only',list:'List',clean:'Hide buttons',close:'Close',
      listWait:'The list has not arrived yet. Let the video play a moment, then open it again.',video:'Video',
      rotate:'Turn your phone sideways',normal:'Back to normal',
      bad:'No valid link found. Paste a video or playlist link.',noclip:'Clipboard unavailable. Paste the link into the box.',clipdeny:'Clipboard access denied. Paste the link manually.'}
  };
  function tr(k){return L.en[k]}
  Object.assign(L.en,{searchPh:'Search…',searching:'Searching…',ph:'Paste a video or playlist link',paste:'Paste',go:'Play',
    forYou:'For you',popular:'Popular picks',recent:'Recently watched',feedHint:'Watch a few videos and this page will learn what you like.',feedHintOff:'Want picks based on what you watch? Switch on “Personalized feed” in More options. It stays off by default because it sends phrases from your history through the relay.',
    feedFail:'Could not load videos right now.',retry:'Try again',views:'views',results:'Results',clearHist:'Clear my history',
    clearAsk:'Clear your watch history on this device?',historyMore:'Show more',historyLess:'Show less',install:'Install as an app',refresh:'Refresh',
    loadingMore:'Loading more videos…',loadingFeed:'Loading videos…',refreshingFeed:'Finding fresh videos…',
    play:'Play',pause:'Pause',playerLoading:'Loading video…',playerTap:'Video is ready. Tap Play if it does not start.',playerError:'YouTube could not play this video. Try another video.',removeHistory:'Remove from watch history',autoplayOn:'Turn autoplay on',autoplayOff:'Turn autoplay off',autoplayEnabled:'Autoplay on',autoplayDisabled:'Autoplay off'});
  var yt=$('yt'),slide=$('slide'),stage=$('stage'),flash=$('flash');
  var playing=true,fill=false,busy=false,autoplayEnabled=ls('autoplay')!=='0';
  var privacyMode=ls('privacyMode')==='1';
  // "For you" builds search phrases from watched titles, and those phrases leave the
  // device. It is therefore opt-in: off until the visitor switches it on.
  var personalizeFeed=ls('personalize')==='1';
  function feedHistory(){return (privacyMode||!personalizeFeed)?[]:getHist()}
  var linkMode=false;
  var DEFAULT_REGION='JO';
  var ids=[],cur=-1,T={},io=null,q=[],active=0;
  var playlistIds=[],originalPlaylistId=null,preserveSavedPlaylist=false;
  var customQueueActive=false,customQueueIds=[],customQueueIndex=-1,currentDurationHint=0;
  var customAdvanceTimer=0,lastAutoAdvanceId='';
  var currentVideoId='',currentTab='playlist',recommendedVideos=[],recommendedFor='',recommendationSeq=0;
  var historyExpanded=false,HISTORY_LIMIT=500,HISTORY_PREVIEW=3,historyDeleted=Object.create(null);
  // Watch history expires on its own: entries older than this are dropped and erased.
  var HISTORY_MAX_AGE_MS=90*24*60*60*1000;
  var videoInfoCache=Object.create(null),videoInfoRequests=Object.create(null),videoInfoCacheOrder=[];
  function rememberVideoInfo(id,data){
    if(videoInfoCache[id])videoInfoCacheOrder=videoInfoCacheOrder.filter(function(x){return x!==id});
    videoInfoCache[id]=data;videoInfoCacheOrder.push(id);
    while(videoInfoCacheOrder.length>12){var old=videoInfoCacheOrder.shift();delete videoInfoCache[old]}
  }

  // The browser never contacts a metadata provider itself. Every provider request
  // goes through the same-origin relay, so no third-party operator ever sees the
  // visitor's IP address or learns which video is being previewed.
  var storyboardCueRequests=Object.create(null);
  var storyboardPreviewRetryAt=Object.create(null);
  var storyboardImageCache=Object.create(null);
  // Keep only the active video's proactively warmed sprite key.
  var preloadedStoryboardKey='';

  // Opt-in mobile diagnostics: open the preview with ?sbdebug=1.
  var SB_DEBUG=/[?&]sbdebug=1(?:&|$)/.test(location.search);
  var sbStage='',sbSeconds=0,storyboardLastError=Object.create(null);
  function renderPreviewTime(){
    var time=$('previewTime');
    if(time)time.textContent=fmt(sbSeconds)+(SB_DEBUG&&sbStage?' · '+sbStage:'');
  }
  function setSbStage(text){
    sbStage=String(text||'');
    if(SB_DEBUG)renderPreviewTime();
  }
  function noFrameReason(id){
    if(videoInfoRequests[id])return 'waiting-for-video-info';
    var data=videoInfoCache[id];
    if(!data)return storyboardLastError[id]?'relay-failed: '+storyboardLastError[id]:'no-video-info';
    var reasons=[];
    (Array.isArray(data.storyboardDiagnostics)?data.storyboardDiagnostics:[]).forEach(function(item){
      var source=item&&item.source==='youtube-watch'?'yt':'inv';
      var label=source+':'+String(item&&item.reason||'unknown');
      if(reasons.indexOf(label)<0)reasons.push(label);
    });
    (Array.isArray(data.storyboardCueDiagnostics)?data.storyboardCueDiagnostics:[]).forEach(function(item){
      var label='vtt:'+String(item&&item.reason||'unavailable');
      if(reasons.indexOf(label)<0)reasons.push(label);
    });
    if(data.metadataAvailable===false)reasons.push('metadata:unavailable');
    var hasBoards=Array.isArray(data.storyboards)&&data.storyboards.length>0;
    return (hasBoards?'boards-unusable':'no-storyboards')+(reasons.length?' ['+reasons.slice(0,4).join(', ')+']':'');
  }

  function storyboardImagePathMatches(path,id){
    var parts=String(path||'').split('/');
    if(parts[0]!==''||parts[1]!=='sb')return false;
    var videoIndex=2,authority=parts[2]||'';
    if(authority==='i'||(authority.length===2&&authority.charAt(0)==='i'&&authority.charAt(1)>='0'&&authority.charAt(1)<='9'))videoIndex=3;
    return parts[videoIndex]===id&&!!parts[videoIndex+1];
  }
  function isStoryboardImageUrl(raw,id){
    try{
      var u=new URL(raw,location.origin);
      if(u.origin===location.origin&&u.pathname==='/api/storyboard'){
        if(u.username||u.password||u.port||u.hash||u.searchParams.getAll('url').length!==1)return false;
        var nested=u.searchParams.get('url');
        var target=new URL(nested);
        var nestedHost=target.hostname==='i.ytimg.com'||target.hostname.endsWith('.ytimg.com');
        return target.protocol==='https:'&&nestedHost&&!target.username&&!target.password&&
          !target.port&&!target.hash&&storyboardImagePathMatches(target.pathname,id);
      }
      var ytImageHost=u.hostname==='i.ytimg.com'||u.hostname.endsWith('.ytimg.com');
      return u.protocol==='https:'&&ytImageHost&&
        !u.username&&!u.password&&!u.port&&!u.hash&&storyboardImagePathMatches(u.pathname,id);
    }catch(e){return false}
  }
  function storyboardImageFallbackUrl(raw,id){
    try{
      var u=new URL(raw,location.origin);
      if(u.origin===location.origin&&u.pathname==='/api/storyboard'){
        var nested=u.searchParams.get('url');
        return nested&&isStoryboardImageUrl(nested,id)?new URL(nested).href:'';
      }
      if(u.origin!==location.origin&&isStoryboardImageUrl(u.href,id)){
        return '/api/storyboard?url='+encodeURIComponent(u.href);
      }
    }catch(e){}
    return '';
  }
  function hasUsableStoryboards(data,id){
    var boards=data&&Array.isArray(data.storyboards)?data.storyboards:[];
    return boards.some(function(b){
      var template=b&&typeof b.templateUrl==='string'?b.templateUrl.replace(/\$M/g,'0').replace(/%24M/gi,'0'):'';
      return b&&+b.width>0&&+b.height>0&&+b.count>0&&+b.storyboardWidth>0&&
        +b.storyboardHeight>0&&isStoryboardImageUrl(template,id);
    });
  }
  function ensureStoryboardCues(id,data){
    // Cues cost one more provider call; the relay recommends them only when it already
    // involved the provider that serves them. Otherwise frames are computed from the sheets.
    if(!data||data.cuesRecommended!==true)return Promise.resolve(data);
    if(Array.isArray(data&&data.storyboardCues)&&data.storyboardCues.length)return Promise.resolve(data);
    if(storyboardCueRequests[id])return storyboardCueRequests[id];
    var boards=data&&Array.isArray(data.storyboards)?data.storyboards:[];
    boards=boards.filter(function(b){return b&&+b.width>0&&+b.height>0}).sort(function(a,b){return (+b.width||0)-(+a.width||0)});
    if(!boards.length)return Promise.resolve(data);
    var board=boards[0];
    var url='/api/v1/storyboards/'+encodeURIComponent(id)+'?width='+encodeURIComponent(board.width)+'&height='+encodeURIComponent(board.height)+'&region='+DEFAULT_REGION;
    var req=apiGet(url,function(cues){
      return Array.isArray(cues)&&cues.length>0&&cues.every(function(c){
        return c&&Number.isFinite(+c.start)&&Number.isFinite(+c.end)&&+c.end>+c.start&&
          +c.x>=0&&+c.y>=0&&+c.w>0&&+c.h>0&&isStoryboardImageUrl(c.url,id);
      });
    }).then(function(cues){
      data.storyboardCues=cues;
      rememberVideoInfo(id,data);
      return data;
    }).catch(function(error){
      if(error&&Array.isArray(error.providers)){
        data.storyboardCueDiagnostics=error.providers;
        rememberVideoInfo(id,data);
      }
      return data;
    });
    storyboardCueRequests[id]=req;
    return req.then(function(result){
      if(storyboardCueRequests[id]===req)delete storyboardCueRequests[id];
      return result;
    },function(error){
      if(storyboardCueRequests[id]===req)delete storyboardCueRequests[id];
      throw error;
    });
  }
  function enrichStoryboardData(id,data){
    return ensureStoryboardCues(id,data);
  }
  var requestedStartId='',requestedStartQueue=[],startCorrectionSent=false;
  var playerLoadToken=0,playerStartTimer=0,playerHasStarted=false,playerWantsPlay=false;
  var dur=0,tcur=0,drag=false,lastSec=-1,lastTap=0,progressPollTimer=0,controlsHideTimer=0;
  var progressClockRunning=false,lastClockAt=0,lastRemoteTimeAt=0,progressPollToken=0;
  function fmt(s){s=Math.max(0,Math.floor(s));var m=Math.floor(s/60),h=Math.floor(m/60),r=('0'+s%60).slice(-2);return h?h+':'+('0'+m%60).slice(-2)+':'+r:m+':'+r}
  function setInlineIcon(el,kind){
    if(!el)return;
    var ns='http://www.w3.org/2000/svg';
    var svg=document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','0 0 24 24');
    svg.setAttribute('aria-hidden','true');
    var path=document.createElementNS(ns,'path');
    if(kind==='pause')path.setAttribute('d','M9 5v14M15 5v14');
    else if(kind==='remove')path.setAttribute('d','M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3');
    else {path.setAttribute('d','M8 5.5v13l11-6.5z');path.setAttribute('fill','#fff')}
    svg.appendChild(path);el.textContent='';el.appendChild(svg);
  }
  function paint(t){
    if(!Number.isFinite(dur)||dur<=0)return;
    t=Math.max(0,Math.min(dur,Number.isFinite(+t)?+t:0));
    $('pf').style.transform='scaleX('+Math.max(0,Math.min(1,t/dur))+')';
    var sec=Math.floor(t),currentText=fmt(t),durationText=fmt(dur);
    if(sec!==lastSec||$('tmCurrent').textContent!==currentText){lastSec=sec;$('tmCurrent').textContent=currentText}
    if($('tmDuration').textContent!==durationText)$('tmDuration').textContent=durationText;
  }
  function seek(t){
    if(!Number.isFinite(+t))return;
    if(dur)t=Math.min(+t,Math.max(0,dur-0.25));
    t=Math.max(0,+t);cmd('seekTo',[t,true]);tcur=t;lastSec=-1;
    lastClockAt=Date.now();lastRemoteTimeAt=lastClockAt;paint(t);
    if(playerHasStarted)cmd('getCurrentTime');
  }
  function startProgressPolling(token){
    if(progressPollTimer&&progressPollToken===token)return;
    clearInterval(progressPollTimer);progressPollToken=token;lastClockAt=Date.now();
    progressPollTimer=setInterval(function(){
      if(token!==playerLoadToken||stage.hidden||!playerHasStarted)return;
      var now=Date.now(),elapsed=Math.min(1.5,Math.max(0,(now-lastClockAt)/1000));
      lastClockAt=now;
      if(progressClockRunning&&dur>0&&now-lastRemoteTimeAt>1800&&elapsed>0){
        tcur=Math.min(dur,tcur+elapsed);if(!drag)paint(tcur);saveHistoryProgress();
      }
      if(!drag)cmd('getCurrentTime');
      if(!dur)cmd('getDuration');
    },500);
  }
  function scheduleControlsHide(){
    clearTimeout(controlsHideTimer);
    if(stage.hidden||!playing||$('list').classList.contains('open'))return;
    controlsHideTimer=setTimeout(function(){
      if(stage.hidden||!playing||$('list').classList.contains('open'))return;
      if(drag){scheduleControlsHide();return}
      stage.classList.add('controls-hidden');
    },2800);
  }
  function revealControls(){
    if(stage.hidden)return;
    stage.classList.remove('controls-hidden');scheduleControlsHide();
  }
  function updatePlayButton(){
    var b=$('b-toggle');if(!b)return;
    b.dataset.a=playing?'pause':'play';b.setAttribute('aria-label',tr(playing?'pause':'play'));
    setInlineIcon(b,playing?'pause':'play');
  }
  function updateAutoplayButton(){
    var b=$('b-autoplay');if(!b)return;
    var label=tr(autoplayEnabled?'autoplayOff':'autoplayOn');
    b.classList.toggle('on',autoplayEnabled);
    b.setAttribute('aria-pressed',autoplayEnabled?'true':'false');
    b.setAttribute('aria-label',label);b.title=label;
  }
  function storyboardAt(id,seconds){
    var data=videoInfoCache[id],target=Math.max(0,Number(seconds)||0);
    var cues=data&&Array.isArray(data.storyboardCues)?data.storyboardCues:[];
    if(cues.length){
      for(var c=0;c<cues.length;c++){
        var cue=cues[c];
        if(target>=+cue.start&&target<+cue.end){
          return {url:cue.url,x:+cue.x,y:+cue.y,w:+cue.w,h:+cue.h,videoId:id};
        }
      }
      if(target>=+cues[cues.length-1].end){
        var last=cues[cues.length-1];
        return {url:last.url,x:+last.x,y:+last.y,w:+last.w,h:+last.h,videoId:id};
      }
    }
    var boards=data&&Array.isArray(data.storyboards)?data.storyboards:[];
    if(!boards.length)return null;
    boards=boards.filter(function(b){
      return b&&typeof b.templateUrl==='string'&&+b.width>0&&+b.height>0&&+b.count>0&&
        +b.storyboardWidth>0&&+b.storyboardHeight>0;
    }).sort(function(a,b){return (+b.width||0)-(+a.width||0)});
    for(var i=0;i<boards.length;i++){
      var sb=boards[i],width=+sb.width,height=+sb.height;
      var count=Math.floor(+sb.count),columns=Math.floor(+sb.storyboardWidth),rows=Math.floor(+sb.storyboardHeight);
      var perSheet=columns*rows;
      if(!(count>0)||!(perSheet>0))continue;
      var interval=+sb.interval;
      if(!(interval>0))interval=Math.max(1,(+(data.lengthSeconds)||dur||1)*1000/count);
      var frameIndex=Math.max(0,Math.min(count-1,Math.floor(target*1000/interval)));
      var imageIndex=Math.floor(frameIndex/perSheet);
      var storyboardCount=Math.floor(+sb.storyboardCount)||Math.ceil(count/perSheet);
      imageIndex=Math.min(storyboardCount-1,imageIndex);
      var cellIndex=frameIndex%perSheet;
      var x=(cellIndex%columns)*width,y=Math.floor(cellIndex/columns)*height;
      var url=sb.templateUrl.replace(/\$M/g,String(imageIndex)).replace(/%24M/gi,String(imageIndex));
      if(!isStoryboardImageUrl(url,id))continue;
      return {url:url,x:x,y:y,w:width,h:height,columns:columns,rows:rows,cellIndex:cellIndex,
        sheetWidth:width*columns,sheetHeight:height*rows,board:sb,videoId:id};
    }
    return null;
  }
  function finishStoryboardImageLoad(entry,frame,thumb,tw,key){
    entry.loaded=true;entry.failed=false;
    var latest=thumb&&thumb._storyboardFrame;
    if(!latest||latest.videoId!==frame.videoId||latest.url!==key||thumb.dataset.previewUrl!==key)return;
    var cols=Math.max(1,Math.floor(entry.image.naturalWidth/latest.w));
    var rows=Math.max(1,Math.floor(entry.image.naturalHeight/latest.h));
    var board=latest.board;
    if(board&&(cols!==latest.columns||rows!==latest.rows)){
      board.storyboardWidth=cols;board.storyboardHeight=rows;
      board.storyboardCount=Math.max(1,Math.ceil((+board.count||1)/(cols*rows)));
    }
    drawStoryboardPreview(latest,thumb,tw);
  }
  function drawStoryboardPreview(frame,thumb,tw){
    var key=frame.url;
    thumb._storyboardFrame=frame;
    var entry=storyboardImageCache[key];
    if(!entry){
      entry=storyboardImageCache[key]={loaded:false,failed:false,src:key,image:new Image(),fallbackTried:false};
      entry.image.onload=function(){finishStoryboardImageLoad(entry,frame,thumb,tw,key)};
      entry.image.onerror=function(){
        if(!entry.fallbackTried){
          var fallback=storyboardImageFallbackUrl(key,frame.videoId);
          if(fallback){
            entry.fallbackTried=true;entry.loaded=false;entry.failed=false;entry.src=fallback;entry.image=new Image();
            entry.image.onload=function(){finishStoryboardImageLoad(entry,frame,thumb,tw,key)};
            entry.image.onerror=function(){
              entry.failed=true;
              if(thumb.dataset.previewUrl===key){
                thumb.style.backgroundImage='none';
                if(SB_DEBUG)setSbStage('img-fail: direct+proxy');
              }
            };
            entry.image.src=fallback;
            return;
          }
        }
        entry.failed=true;
        if(thumb.dataset.previewUrl===key){
          thumb.style.backgroundImage='none';
          if(SB_DEBUG)setSbStage('img-fail: direct');
        }
      };
      entry.image.src=key;
    }
    if(SB_DEBUG)setSbStage(entry.failed?'img-fail':!entry.loaded?(entry.fallbackTried?'img-loading (proxy)':'img-loading'):(entry.fallbackTried?'img-ok (proxy)':'img-ok'));
    if(entry.failed){thumb.style.backgroundImage='none';return}
    if(!entry.loaded){
      thumb.style.backgroundImage='none';
      return;
    }
    var naturalWidth=entry.image.naturalWidth||frame.sheetWidth||frame.w;
    var naturalHeight=entry.image.naturalHeight||frame.sheetHeight||frame.h;
    var columns=Math.max(1,Math.floor(naturalWidth/frame.w));
    var tileX=Number.isFinite(+frame.x)?+frame.x:((+frame.cellIndex%columns)*frame.w);
    var tileY=Number.isFinite(+frame.y)?+frame.y:(Math.floor(+frame.cellIndex/columns)*frame.h);
    if(frame.board&&Number.isFinite(+frame.cellIndex)){
      tileX=(+frame.cellIndex%columns)*frame.w;
      tileY=Math.floor(+frame.cellIndex/columns)*frame.h;
    }
    var scale=tw/frame.w;
    thumb.style.backgroundImage='url("'+entry.src.replace(/"/g,'')+'")';
    thumb.style.backgroundSize=(naturalWidth*scale)+'px '+(naturalHeight*scale)+'px';
    thumb.style.backgroundPosition=(-tileX*scale)+'px '+(-tileY*scale)+'px';
    thumb.style.backgroundRepeat='no-repeat';
  }
  function preloadStoryboardPreview(id){
    if(!id||id!==currentVideoId||seekHover)return;
    var frame=storyboardAt(id,0);
    if(!frame)return;
    var thumb=$('seekThumb'),tw=160,key=frame.url;
    if(!thumb)return;
    if(preloadedStoryboardKey&&preloadedStoryboardKey!==key){
      delete storyboardImageCache[preloadedStoryboardKey];
    }
    preloadedStoryboardKey=key;
    thumb.style.width=tw+'px';
    thumb.style.height=Math.max(54,Math.round(tw*frame.h/frame.w))+'px';
    thumb.dataset.previewUrl=key;
    drawStoryboardPreview(frame,thumb,tw);
  }
  var lastSeekPreviewEvent=null,seekMetadataWaitId='';
  function requestStoryboardPreviewData(id){
    if(!id)return null;
    if(videoInfoRequests[id])return videoInfoRequests[id];
    var now=Date.now(),last=storyboardPreviewRetryAt[id]||0;
    if(now-last<10000)return null;
    storyboardPreviewRetryAt[id]=now;
    try{return loadVideoInfo(id)}catch(e){return null}
  }
  function hideSeekPreview(){var p=$('seekPreview');if(p)p.style.display='none';seekHover=false;lastSeekPreviewEvent=null}
  function showSeekPreview(e){
    if(!dur||!trk)return;
    lastSeekPreviewEvent={clientX:e.clientX,clientY:e.clientY};
    var r=trk.getBoundingClientRect(),ratio=rot()?(e.clientY-r.top)/Math.max(1,r.height):(e.clientX-r.left)/Math.max(1,r.width);
    ratio=Math.max(0,Math.min(1,ratio));
    var previewVideoId=currentVideoId,seconds=ratio*dur,frame=storyboardAt(previewVideoId,seconds);
    var pendingInfo=previewVideoId&&videoInfoRequests[previewVideoId];
    if(!frame&&!pendingInfo)pendingInfo=requestStoryboardPreviewData(previewVideoId);
    if(!frame&&pendingInfo&&seekMetadataWaitId!==previewVideoId){
      seekMetadataWaitId=previewVideoId;
      pendingInfo.then(function(){
        if(previewVideoId===currentVideoId&&seekHover&&lastSeekPreviewEvent){
          showSeekPreview(lastSeekPreviewEvent);
        }
      }).catch(function(){
        if(SB_DEBUG&&previewVideoId===currentVideoId&&seekHover&&lastSeekPreviewEvent){
          showSeekPreview(lastSeekPreviewEvent);
        }
      }).then(function(){
        if(seekMetadataWaitId===previewVideoId)seekMetadataWaitId='';
      });
    }
    var p=$('seekPreview'),thumb=$('seekThumb'),tw=160;
    p.classList.toggle('no-thumb',!frame);p.style.display='flex';
    var half=Math.min(p.offsetWidth/2,Math.max(24,trk.clientWidth/2));
    var left=Math.max(half,Math.min(trk.clientWidth-half,ratio*trk.clientWidth));
    p.style.left=left+'px';sbSeconds=seconds;renderPreviewTime();
    if(frame){
      var th=Math.max(54,Math.round(tw*frame.h/frame.w));
      thumb.style.width=tw+'px';thumb.style.height=th+'px';
      thumb.dataset.previewUrl=frame.url;
      drawStoryboardPreview(frame,thumb,tw);
    }else{
      thumb.style.backgroundImage='none';
      thumb.dataset.previewUrl='';
      thumb._storyboardFrame=null;
      if(SB_DEBUG)setSbStage(noFrameReason(previewVideoId));
    }
    seekHover=true;
  }
  function tap(x){
    var wasHidden=stage.classList.contains('controls-hidden');
    var now=Date.now(),w=rot()?window.innerHeight:window.innerWidth,side=x<w/3?-1:(x>w*2/3?1:0);
    if(side&&lastTap&&now-lastTap<320){
      lastTap=0;seek(tcur+side*10);flash.textContent=side>0?'+10':'−10';
      flash.classList.add('show');setTimeout(function(){flash.classList.remove('show')},450);
      if(!wasHidden)scheduleControlsHide();
      return;
    }
    lastTap=side?now:0;
    if(wasHidden){revealControls();return}
    clearTimeout(controlsHideTimer);stage.classList.add('controls-hidden');
  }
  function touchTitleKey(id){
    var keys=[];try{keys=JSON.parse(ls('titleKeys')||'[]')}catch(e){}
    if(!Array.isArray(keys))keys=[];
    keys=keys.filter(function(x){return x!==id});keys.push(id);
    while(keys.length>150){
      var old=keys.shift();delete T[old];
      try{localStorage.removeItem('malektube:v2:t:'+old)}catch(e){}
    }
    ls('titleKeys',JSON.stringify(keys));
  }
  function title(id){
    if(T[id])return T[id];
    var v=ls('t:'+id);
    if(v){T[id]=v;touchTitleKey(id)}
    return v;
  }
  function saveTitle(id,t){
    if(!id||!t)return;
    t=String(t).slice(0,300);
    if(T[id]!==t){T[id]=t;ls('t:'+id,t)}
    touchTitleKey(id);
    document.querySelectorAll('.row[data-id="'+id+'"]').forEach(function(r){var target=r.classList.contains('rec-row')?r.querySelector('.rec-title'):r.querySelector('span');if(target)target.textContent=t});
  }
  function fetchTitle(id,done){
    fetch('/api/youtube/oembed?videoId='+encodeURIComponent(id),{credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.title)saveTitle(id,j.title)}).catch(function(){}).then(done);
  }
  // Search and metadata use the same-origin Cloudflare Pages Advanced Mode Worker.
  var searchTimer=null,suggestTimer=null,searchSeq=0,suggestSeq=0;
  function apiErrorText(err){
    var message=err&&err.message?String(err.message):'Request failed';
    if(err&&err.name==='AbortError')message='Request timed out';
    if(err&&err.relayVersion)message+=' · '+err.relayVersion;
    return message.slice(0,260);
  }
  function thumbnailUrl(id){
    return '/api/thumb/'+encodeURIComponent(id);
  }
  function apiGet(path,validateData){
    try{
      var safePath=new URL(path,location.origin);
      if(safePath.origin!==location.origin||safePath.pathname.indexOf('/api/v1/')!==0||safePath.hash)throw new Error('Blocked API path');
      path=safePath.pathname+safePath.search;
    }catch(e){return Promise.reject(new Error('Blocked API path'))}
    var controller=(typeof AbortController!=='undefined')?new AbortController():null;
    var timer=controller?setTimeout(function(){controller.abort()},26000):null;
    var opts={method:'GET',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Accept':'application/json'}};
    if(controller)opts.signal=controller.signal;
    return fetch(path,opts).then(function(r){
      if(!r.ok){
        return r.text().then(function(raw){
          var body=null;
          try{body=JSON.parse(raw)}catch(e){}
          var detail='HTTP '+r.status;
          if(body&&Array.isArray(body.providers)&&body.providers.length){
            detail+=' — '+body.providers.slice(0,5).map(function(p){
              return String(p.host||'provider')+': '+String(p.status||'failed')+(p.reason?' ('+String(p.reason)+')':'');
            }).join(', ');
          }else if(body&&body.error){
            detail+=' — '+String(body.error).slice(0,140);
          }
          var err=new Error(detail);
          if(body&&Array.isArray(body.providers))err.providers=body.providers;
          err.relayVersion=r.headers.get('X-MTube-Relay')||'unknown relay';
          throw err;
        });
      }
      return r.json();
    }).then(function(data){
      if(validateData&&!validateData(data))throw new Error('Invalid API response');
      return data;
    }).finally(function(){if(timer)clearTimeout(timer)});
  }
  function renderRecommendations(id,data){
    if(id!==currentVideoId||currentTab!=='recommendations')return;
    var rows=$('rows');rows.textContent='';
    var items=Array.isArray(data&&data.recommendedVideos)?data.recommendedVideos:[];
    items=items.filter(function(v){return v&&validVideoId(v.videoId)&&v.videoId!==id}).slice(0,35);
    recommendedVideos=items;recommendedFor=id;
    if(!items.length){var p=document.createElement('p');p.className='list-message';p.textContent=tr('recEmpty');rows.appendChild(p);return}
    var frag=document.createDocumentFragment();
    items.forEach(function(v,i){
      var r=document.createElement('div');r.className='row rec-row';r.dataset.id=v.videoId;r.dataset.rec='1';r.dataset.i=i;r.dataset.duration=String(+v.lengthSeconds||0);
      var n=document.createElement('i');n.textContent=i+1;
      var im=document.createElement('img');im.loading='lazy';im.decoding='async';im.alt='';im.src=thumbnailUrl(v.videoId);
      var copy=document.createElement('span');copy.className='rec-copy';
      var titleEl=document.createElement('span');titleEl.className='rec-title';titleEl.textContent=v.title||tr('video');
      var meta=document.createElement('small');meta.className='rec-meta';
      var bits=[];if(v.author)bits.push(v.author);if(v.viewCountText)bits.push(v.viewCountText);if(v.publishedText)bits.push(v.publishedText);meta.textContent=bits.join(' • ');
      copy.appendChild(titleEl);copy.appendChild(meta);r.appendChild(n);r.appendChild(im);r.appendChild(copy);frag.appendChild(r);
      if(v.title)saveTitle(v.videoId,v.title);
    });
    rows.appendChild(frag);
  }
  function resumePendingVideo(){
    if(!pendingResumeId||pendingResumeId!==currentVideoId||pendingResumeAt<=5||!playing)return;
    var resumeId=pendingResumeId,resumeAt=pendingResumeAt;
    pendingResumeId='';pendingResumeAt=0;
    setTimeout(function(){if(currentVideoId===resumeId)seek(resumeAt)},700);
  }
  function applyDurationFallback(id,data){
    var seconds=Number(data&&data.lengthSeconds);
    if(id===currentVideoId&&dur<=0&&Number.isFinite(seconds)&&seconds>0){
      dur=seconds;lastSec=-1;paint(tcur);
    }
  }
  function loadVideoInfo(id){
    if(!id)return Promise.reject(new Error('No current video'));
    if(videoInfoRequests[id])return videoInfoRequests[id];
    if(videoInfoCache[id]){
      var cached=videoInfoCache[id];
      if(id===currentVideoId)preloadStoryboardPreview(id);
      var cachedRequest=enrichStoryboardData(id,cached).then(function(data){
        if(id===currentVideoId){preloadStoryboardPreview(id);applyDurationFallback(id,data);if(currentTab==='recommendations')renderRecommendations(id,data)}
        return data;
      });
      videoInfoRequests[id]=cachedRequest;
      cachedRequest.then(function(){delete videoInfoRequests[id]},function(){delete videoInfoRequests[id]});
      return cachedRequest;
    }
    var url='/api/v1/videos/'+encodeURIComponent(id)+'?fields=videoId,title,author,lengthSeconds,genre,keywords,storyboards,recommendedVideos(videoId,title,author,lengthSeconds,viewCount,viewCountText,publishedText)&hl=en&region='+DEFAULT_REGION;
    var req=apiGet(url,function(data){return !!(data&&validVideoId(data.videoId))}).then(function(data){
      rememberVideoInfo(id,data);
      if(id===currentVideoId)preloadStoryboardPreview(id);
      return enrichStoryboardData(id,data).then(function(enriched){
        if(id===currentVideoId){preloadStoryboardPreview(id);applyDurationFallback(id,enriched);if(currentTab==='recommendations')renderRecommendations(id,enriched)}
        return enriched;
      });
    }).catch(function(err){
      storyboardLastError[id]=String(err&&err.message||err).slice(0,60);
      if(id===currentVideoId&&currentTab==='recommendations')showListMessage(tr('recFail')+' ('+apiErrorText(err)+')');
      throw err;
    });
    videoInfoRequests[id]=req;
    req.then(function(){delete videoInfoRequests[id]},function(){delete videoInfoRequests[id]});
    return req;
  }
  function showListMessage(message){var rows=$('rows');rows.textContent='';var p=document.createElement('p');p.className='list-message';p.textContent=message;rows.appendChild(p)}
  function loadRecommendations(){
    var id=currentVideoId,seq=++recommendationSeq;
    if(!id){showListMessage(tr('noCurrent'));return}
    if(recommendedFor===id&&recommendedVideos.length){renderRecommendations(id,{recommendedVideos:recommendedVideos});return}
    showListMessage(tr('recWait'));
    loadVideoInfo(id).then(function(data){if(seq===recommendationSeq&&currentVideoId===id&&currentTab==='recommendations')renderRecommendations(id,data)}).catch(function(err){if(seq===recommendationSeq&&currentTab==='recommendations')showListMessage(tr('recFail')+' ('+apiErrorText(err)+')')});
  }
  function setCurrentVideo(id,videoTitle){
    if(!validVideoId(id))return;
    var changed=currentVideoId!==id;
    if(changed&&currentVideoId)recordHistory(currentVideoId);
    currentVideoId=id;
    if(videoTitle)saveTitle(id,videoTitle);
    if(changed){
      delete historyDeleted[id];
      var wasPlaying=playerHasStarted&&playing;
      dur=0;tcur=0;lastSec=-1;progressClockRunning=wasPlaying;lastClockAt=Date.now();lastRemoteTimeAt=lastClockAt;
      lastAutoAdvanceId='';
      if(customQueueActive){
        var queueIndex=customQueueIds.indexOf(id);
        if(queueIndex>=0){customQueueIndex=queueIndex;cur=queueIndex;if($('list').classList.contains('open')&&currentTab==='playlist')setCur(queueIndex)}
      }
      $('pf').style.transform='scaleX(0)';$('tmCurrent').textContent='0:00';$('tmDuration').textContent='0:00';hideSeekPreview();
      clearTimeout(histTimer);(function(hid){histTimer=setTimeout(function(){recordHistory(hid)},12000)})(id);
      if(currentDurationHint>0){dur=currentDurationHint;currentDurationHint=0;paint(tcur)}
      recommendedVideos=[];recommendedFor='';
      loadVideoInfo(id).catch(function(){});
      if($('list').classList.contains('open')&&currentTab==='recommendations')loadRecommendations();
    }
  }
  function hideSuggestions(){var box=$('suggestions');box.hidden=true;box.textContent=''}
  function showSuggestions(items,seq){
    if(seq!==suggestSeq)return;
    var box=$('suggestions');box.textContent='';
    (items||[]).slice(0,7).forEach(function(value){
      if(typeof value!=='string'||!value.trim())return;
      var b=document.createElement('button');b.type='button';b.className='suggestion';b.setAttribute('role','option');b.textContent=value;
      b.addEventListener('click',function(){$('searchInput').value=value;hideSuggestions();searchVideos(value)});
      box.appendChild(b);
    });
    box.hidden=!box.childNodes.length;
  }
  function loadSuggestions(value){
    var seq=++suggestSeq;
    if(value.length<2){hideSuggestions();return}
    apiGet('/api/v1/search/suggestions?q='+encodeURIComponent(value),function(data){return !!(data&&Array.isArray(data.suggestions))}).then(function(data){
      showSuggestions(data&&data.suggestions,seq);
    }).catch(function(){if(seq===suggestSeq)hideSuggestions()});
  }
  function searchLanguageForQuery(query){return /\p{Script=Arabic}/u.test(String(query||''))?'ar':'en'}
  function loadSearchPage(page,seq,append){
    if(searchLoading||!searchHasMore)return;
    if(append&&!searchNextPage){searchHasMore=false;return}
    searchLoading=true;setMoreLoading('results',true);
    var language=searchLanguageForQuery(currentSearchQuery),path='/api/v1/search?q='+encodeURIComponent(currentSearchQuery)+'&type=video&page='+page+'&region='+DEFAULT_REGION+'&hl='+language;
    if(append)path+='&nextpage='+encodeURIComponent(searchNextPage);
    apiGet(path,function(data){return !!(data&&Array.isArray(data.items)&&(data.nextPage===null||typeof data.nextPage==='string'))}).then(function(data){
      if(seq!==searchSeq)return;
      var videos=data.items.filter(isSearchVideo);
      searchNextPage=typeof data.nextPage==='string'?data.nextPage:'';
      var added=[],known=Object.create(null);searchItems.forEach(function(x){known[x.id]=1});
      videos.forEach(function(v){var it=normItem(v);if(!known[it.id]){known[it.id]=1;added.push(it)}});
      if(!append){searchItems=[];added.forEach(function(x){searchItems.push(x)})}
      else added.forEach(function(x){searchItems.push(x)});
      browseItems=searchItems;searchPage=page;searchHasMore=!!searchNextPage;searchLoading=false;setMoreLoading('results',false);
      if(!append)$('results').textContent='';
      var frag=document.createDocumentFragment();
      added.forEach(function(it,i){frag.appendChild(makeCard(it,searchItems.length-added.length+i,searchItems))});
      $('results').appendChild(frag);$('searchStatus').textContent=searchItems.length?'':tr('noResults');
      recheckSentinel('resultsSentinel');
    }).catch(function(err){
      if(seq!==searchSeq)return;
      searchLoading=false;setMoreLoading('results',false);
      if(!append){
        var status=$('searchStatus');status.textContent=tr('searchFail')+' ('+apiErrorText(err)+')';
      }
    });
  }
  function loadMoreSearch(){
    if(searchLoading||!searchHasMore||$('resultsWrap').hidden)return;
    loadSearchPage(searchPage+1,searchSeq,true);
  }
  function setLinkMode(enabled){
    linkMode=!!enabled;
    var area=$('searchArea'),search=$('searchInput'),url=$('url'),paste=$('paste'),toggle=$('urlModeToggle');
    area.classList.toggle('url-mode',linkMode);
    search.hidden=linkMode;url.hidden=!linkMode;paste.hidden=!linkMode;
    $('searchModeLabel').textContent=linkMode?'VIDEO / PLAYLIST URL':'SEARCH VIDEOS';
    $('searchHint').textContent=linkMode?'PASTE A LINK AND PRESS PLAY':'PRESS ENTER TO EXPLORE';
    $('urlModeText').textContent=linkMode?'SEARCH':'URL';
    toggle.setAttribute('aria-pressed',linkMode?'true':'false');
    toggle.setAttribute('aria-label',linkMode?'Switch to search mode':'Switch to URL mode');
    toggle.title=linkMode?'Return to video search':'Use a video or playlist URL';
    $('searchBtn').setAttribute('aria-label',linkMode?'Play URL':'Search');
    $('searchBtn').title=linkMode?'Play video or playlist':'Search videos';
    hideSuggestions();
    $('err').textContent='';
  }
  function searchVideos(value){
    if(linkMode)setLinkMode(false);
    var query=(value||'').trim().slice(0,200);if(!query)return;
    clearTimeout(searchTimer);clearTimeout(suggestTimer);hideSuggestions();
    currentSearchQuery=query;searchItems=[];browseItems=searchItems;searchPage=0;searchNextPage='';searchLoading=false;setMoreLoading('results',false);searchHasMore=true;
    var seq=++searchSeq,status=$('searchStatus');
    showResults(true);$('resTitle').textContent=query;$('results').textContent='';status.textContent=tr('searching');
    loadSearchPage(1,seq,false);
  }
  $('searchInput').addEventListener('input',function(){
    var value=this.value.trim();clearTimeout(suggestTimer);clearTimeout(searchTimer);
    if(value.length<2){hideSuggestions();return}
    suggestTimer=setTimeout(function(){loadSuggestions(value)},450);
  });
  $('searchInput').addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();searchVideos(this.value)}
    else if(e.key==='Escape')hideSuggestions();
  });
  $('searchBtn').addEventListener('click',function(){
    if(linkMode)run($('url').value);
    else searchVideos($('searchInput').value);
  });
  $('url').addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();run(this.value)}
    else if(e.key==='Escape')$('err').textContent='';
  });
  $('urlModeToggle').addEventListener('click',function(){
    setLinkMode(!linkMode);
    (linkMode?$('url'):$('searchInput')).focus();
  });
  setLinkMode(false);
  document.addEventListener('click',function(e){if(!$('searchArea').contains(e.target))hideSuggestions()});


  // ---------- Home: cards, history and recommendations ----------
  var TOPICS=[['Sports','Sports'],['Gaming','Gaming'],['Cooking','Cooking'],['Quran','Quran recitation']];
  var FEED_N=36,feedSeq=0,lastFeed=null,histTimer=0,activeChip='home',
    feedPlan=[],feedPage=1,feedLoading=false,feedHasMore=true,feedSeen=Object.create(null),feedCursor=0,
    feedNextPages=Object.create(null),
    searchItems=[],searchPage=1,searchLoading=false,searchHasMore=true,currentSearchQuery='',searchNextPage='',
    browseItems=[],browseScrollY=0,browseView='feed',browseQuery='',moreObserver=null,
    historySaveAt=0,historyEpoch=0,pendingResumeId='',pendingResumeAt=0;
  var STOP={};('official video videos channel subscribe youtube the and for with from this that you your new full episode part live').split(' ').forEach(function(w){STOP[w]=1});
  var WSPLIT;try{WSPLIT=new RegExp('[^\\p{L}\\p{N}]+','u')}catch(e){WSPLIT=/[^a-z0-9\u0600-\u06ff]+/}
  function validVideoId(id){return typeof id==='string'&&/^[A-Za-z0-9_-]{11}$/.test(id)}
  function isSearchVideo(v){
    if(!v||!validVideoId(v.videoId))return false;
    var type=String(v.type||'').toLowerCase();
    return !type||type==='video'||type==='shortvideo';
  }
  function normItem(v){return {id:v.videoId,t:String(v.title||'').slice(0,300),a:String(v.author||'').slice(0,120),v:+v.viewCount||0,l:+v.lengthSeconds||0,p:String(v.publishedText||'').slice(0,100)}}
  function durText(s){s=+s||0;if(!s)return '';var h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=s%60;return (h?h+':'+('0'+m).slice(-2):m)+':'+('0'+r).slice(-2)}
  function viewsText(n){n=+n;if(!n)return '';var x;try{x=new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(n)}catch(e){x=n.toLocaleString()}return x+' '+tr('views')}
  function makeCard(it,i,list){
    var b=document.createElement('button');b.type='button';b.className='vcard';b.dataset.videoId=it.id;
    var th=document.createElement('span');th.className='thumb';
    var im=document.createElement('img');im.loading='lazy';im.decoding='async';im.alt='';im.src=thumbnailUrl(it.id);th.appendChild(im);
    var d=durText(it.l);if(d){var em=document.createElement('em');em.textContent=d;th.appendChild(em)}
    var meta=document.createElement('span');meta.className='vmeta';
    var tt=document.createElement('b');tt.textContent=it.t||tr('video');
    var sm=document.createElement('small');sm.textContent=[it.a,viewsText(it.v),it.p].filter(Boolean).join(' • ');
    meta.appendChild(tt);meta.appendChild(sm);b.appendChild(th);b.appendChild(meta);
    b.addEventListener('click',function(){playFrom(list,b.dataset.videoId)});
    return b;
  }
  function saveBrowseState(){
    browseScrollY=window.scrollY||document.documentElement.scrollTop||0;
    browseView=$('resultsWrap').hidden?'feed':'results';
    browseQuery=$('searchInput').value||'';
  }
  function restoreBrowseState(){
    requestAnimationFrame(function(){requestAnimationFrame(function(){window.scrollTo(0,browseScrollY)})});
  }
  function playFrom(list,selectedId){
    if(!validVideoId(selectedId)){hmsg(tr('playerError'));return;}
    var source=Array.isArray(list)?list:[],index=-1;
    for(var n=0;n<source.length;n++){if(source[n]&&source[n].id===selectedId){index=n;break}}
    var qd=index>=0?source.slice(index,index+10):[{id:selectedId}];
    if(!qd.length||qd[0].id!==selectedId)qd=[{id:selectedId}];
    qd.forEach(function(x){if(x.t)saveTitle(x.id,x.t)});
    saveBrowseState();
    start({list:null,vids:qd.map(function(x){return x.id}),durationHint:+(qd[0]&&qd[0].l)||0});
  }
  // watch history (stored only on this device)
  function safeStoredString(value,max){return typeof value==='string'?value.slice(0,max):''}
  function safeStoredNumber(value,min,max,fallback){
    var n=Number(value);
    return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;
  }
  function getHist(){
    try{
      var stored=ls('hist')||'[]';
      if(stored.length>1000000)return [];
      var raw=JSON.parse(stored);
      if(!Array.isArray(raw))return [];
      var clean=[],seen=Object.create(null);
      for(var i=0;i<Math.min(raw.length,HISTORY_LIMIT*2)&&clean.length<HISTORY_LIMIT;i++){
        var e=raw[i];
        if(!e||!validVideoId(e.i)||seen[e.i])continue;
        var stamp=safeStoredNumber(e.ts,0,8640000000000000,0);
        if(!stamp||Date.now()-stamp>HISTORY_MAX_AGE_MS)continue;
        seen[e.i]=1;
        var keywords=Array.isArray(e.k)?e.k.filter(function(x){return typeof x==='string'&&x.trim()}).slice(0,8).map(function(x){return x.slice(0,80)}):[];
        clean.push({
          i:e.i,t:safeStoredString(e.t,300),a:safeStoredString(e.a,120),g:safeStoredString(e.g,120),k:keywords,
          ts:safeStoredNumber(e.ts,0,8640000000000000,0),n:safeStoredNumber(e.n,1,1000000,1),
          p:safeStoredNumber(e.p,0,1000000000,0),l:safeStoredNumber(e.l,0,1000000000,0)
        });
      }
      return clean;
    }catch(e){return []}
  }
  function purgeExpiredHistory(){
    try{
      var stored=ls('hist');if(!stored)return;
      var raw=JSON.parse(stored);if(!Array.isArray(raw))return;
      var kept=getHist();
      if(kept.length!==raw.length)ls('hist',JSON.stringify(kept));
    }catch(e){}
  }
  function recordHistory(id){
    if(privacyMode||!id||historyDeleted[id])return Promise.resolve();
    var epoch=historyEpoch,wasCurrent=id===currentVideoId,position=wasCurrent?Math.floor(tcur||0):0,knownDuration=wasCurrent?Math.floor(dur||0):0;
    function add(d){
      if(privacyMode||epoch!==historyEpoch||historyDeleted[id])return;
      var h=getHist(),old=null;
      h=h.filter(function(e){if(e.i===id){old=e;return false}return true});
      var keywords=((d&&Array.isArray(d.keywords)&&d.keywords.length?d.keywords:(old&&old.k))||[]).slice(0,8).map(function(x){return String(x).slice(0,80)});
      h.unshift({i:id,t:String((d&&d.title)||title(id)||(old&&old.t)||'').slice(0,300),a:String((d&&d.author)||(old&&old.a)||'').slice(0,120),
        g:String((d&&d.genre)||(old&&old.g)||'').slice(0,120),k:keywords,
        ts:Date.now(),n:(old?old.n||1:0)+1,p:wasCurrent?position:Math.max(0,+((old&&old.p)||0)),
        l:knownDuration||+((d&&d.lengthSeconds)||(old&&old.l)||0)});
      ls('hist',JSON.stringify(h.slice(0,HISTORY_LIMIT)));drawHistory();
    }
    var c=videoInfoCache[id];
    if(c){add(c);return Promise.resolve(c)}
    return loadVideoInfo(id).then(function(d){add(d);return d},function(){add(null)});
  }
  function saveHistoryProgress(){
    if(privacyMode||!currentVideoId||!tcur||Date.now()-historySaveAt<10000)return;
    historySaveAt=Date.now();
    var h=getHist(),item=null;
    for(var i=0;i<h.length;i++)if(h[i].i===currentVideoId){item=h[i];break}
    if(!item)return;
    item.p=Math.floor(tcur);if(dur>0)item.l=Math.floor(dur);
    ls('hist',JSON.stringify(h.slice(0,HISTORY_LIMIT)));
  }
  function drawHistory(){
    var all=(privacyMode?[]:getHist()).slice(0,HISTORY_LIMIT),h=historyExpanded?all:all.slice(0,HISTORY_PREVIEW);
    var wrap=$('historyWrap'),box=$('history'),toggle=$('historyToggle');
    if(!wrap||!box)return;
    box.textContent='';
    wrap.hidden=!$('resultsWrap').hidden||!all.length;
    if(!all.length){
      historyExpanded=false;
      if(toggle)toggle.hidden=true;
      return;
    }
    if(toggle){
      toggle.hidden=all.length<=HISTORY_PREVIEW;
      toggle.classList.toggle('expanded',historyExpanded);
      toggle.setAttribute('aria-expanded',historyExpanded?'true':'false');
      toggle.textContent=historyExpanded?tr('historyLess'):tr('historyMore')+' ('+all.length+')';
    }
    var frag=document.createDocumentFragment();
    h.forEach(function(e){
      var card=document.createElement('div');card.className='history-card';
      var b=document.createElement('button');b.type='button';b.className='history-play';b.dataset.videoId=e.i;
      var im=document.createElement('img');im.loading='lazy';im.decoding='async';im.alt='';im.src=thumbnailUrl(e.i);
      var copy=document.createElement('span');copy.className='history-copy';
      var titleEl=document.createElement('b');titleEl.textContent=e.t||title(e.i)||tr('video');
      var meta=document.createElement('small');meta.textContent=[e.a,e.p?fmt(e.p):'',e.ts?new Date(e.ts).toLocaleDateString(): ''].filter(Boolean).join(' • ');
      var progress=document.createElement('span');progress.className='history-progress';
      var fillEl=document.createElement('span'),pct=e.l>0?Math.max(0,Math.min(100,(e.p||0)/e.l*100)):0;fillEl.style.width=pct+'%';progress.appendChild(fillEl);
      copy.appendChild(titleEl);copy.appendChild(meta);copy.appendChild(progress);b.appendChild(im);b.appendChild(copy);
      b.addEventListener('click',function(){
        saveBrowseState();pendingResumeId=e.i;pendingResumeAt=Math.max(0,+e.p||0);
        start({list:null,vids:[e.i],durationHint:+e.l||0});
      });
      var remove=document.createElement('button');remove.type='button';remove.className='history-remove';
      remove.setAttribute('aria-label',tr('removeHistory'));remove.title=tr('removeHistory');
      setInlineIcon(remove,'remove');
      remove.addEventListener('click',function(event){event.preventDefault();event.stopPropagation();removeHistoryItem(e.i)});
      card.appendChild(b);card.appendChild(remove);frag.appendChild(card);
    });
    box.appendChild(frag);
  }
  function removeHistoryItem(id){
    if(!validVideoId(id))return;
    historyDeleted[id]=true;
    if(id===currentVideoId)clearTimeout(histTimer);
    var remaining=getHist().filter(function(item){return item.i!==id});
    ls('hist',JSON.stringify(remaining.slice(0,HISTORY_LIMIT)));
    drawHistory();
  }
  // interest clusters: videos that share keywords / channel are one topic
  function wordsOf(s){return (s||'').toLowerCase().split(WSPLIT).filter(function(w){return w.length>=3&&!STOP[w]})}
  function tokensOf(e){var o={};(e.k||[]).forEach(function(k){wordsOf(k).forEach(function(w){o[w]=1})});wordsOf(e.t).forEach(function(w){o[w]=1});return o}
  function sim(a,b,ea,eb){
    if(ea&&eb&&ea===eb)return 1;
    var n=0,sa=0,sb=0,k;for(k in a){sa++;if(b[k])n++}for(k in b)sb++;
    return n>=2?n/Math.max(1,Math.min(sa,sb)):0;
  }
  function cluster(h){
    var cl=[];
    h.slice(0,40).forEach(function(e,rank){
      var tk=tokensOf(e),w=Math.pow(.94,rank)*(1+.4*Math.min((e.n||1)-1,3)),best=null,bs=0;
      cl.forEach(function(c){c.m.forEach(function(m){var sc=sim(tk,m.tk,e.a,m.a);if(sc>bs){bs=sc;best=c}})});
      var mem={i:e.i,tk:tk,a:e.a};
      if(best&&bs>=.3){best.m.push(mem);best.w+=w}else cl.push({w:w,m:[mem]});
    });
    return cl;
  }
  function relatedOf(id){
    var tail='hl=en&region='+DEFAULT_REGION,base='/api/v1/videos/'+encodeURIComponent(id);
    function pick(d){var a=d&&d.recommendedVideos;return Array.isArray(a)?a.filter(function(v){return v&&validVideoId(v.videoId)&&v.title}).map(normItem):[]}
    if(videoInfoCache[id]){var c=pick(videoInfoCache[id]);if(c.length)return Promise.resolve(c)}
    return apiGet(base+'?fields=recommendedVideos(videoId,title,author,lengthSeconds,viewCount,viewCountText,publishedText)&'+tail,function(data){return !!(data&&Array.isArray(data.recommendedVideos))}).then(pick);
  }
  function searchQ(q,page){
    page=Math.max(1,+page||1);
    var cursor=page>1?(feedNextPages[q]||''):'';
    if(page>1&&!cursor)return Promise.resolve([]);
    var path='/api/v1/search?q='+encodeURIComponent(q)+'&type=video&page='+page+'&region='+DEFAULT_REGION+'&hl=en';
    if(cursor)path+='&nextpage='+encodeURIComponent(cursor);
    return apiGet(path,function(data){return !!(data&&Array.isArray(data.items)&&(data.nextPage===null||typeof data.nextPage==='string'))}).then(function(data){
      feedNextPages[q]=typeof data.nextPage==='string'?data.nextPage:'';
      return data.items.filter(isSearchVideo).map(normItem);
    });
  }
  function planFor(h,rotation){
    rotation=Math.max(1,+rotation||1);
    if(!h.length){
      var topics=TOPICS.slice(),shift=(rotation-1)%topics.length;
      topics=topics.slice(shift).concat(topics.slice(0,shift));
      return topics.slice(0,4).map(function(t){return {slots:Math.round(FEED_N/4),q:t[1]}});
    }
    var cl=cluster(h).sort(function(a,b){return b.w-a.w}).slice(0,4),sum=cl.reduce(function(x,c){return x+c.w},0)||1;
    return cl.map(function(c){
      var seed=h.filter(function(e){return e.i===c.m[0].i})[0]||h[0],terms=[];
      wordsOf(seed.t).slice(0,5).forEach(function(w){if(terms.indexOf(w)<0)terms.push(w)});
      (seed.k||[]).slice(0,3).forEach(function(w){wordsOf(w).forEach(function(x){if(terms.indexOf(x)<0&&terms.length<7)terms.push(x)})});
      var query=terms.slice(0,7).join(' ')||seed.t||seed.a||'YouTube';
      return {slots:Math.max(5,Math.round(FEED_N*c.w/sum)),q:query};
    });
  }
  function mergeFeed(plan,lists,h,excluded){
    var watched={},authors={},blocked=excluded||Object.create(null);
    h.forEach(function(e){watched[e.i]=1;if(e.a)authors[e.a]=(authors[e.a]||0)+1});
    var cols=plan.map(function(p,i){
      var arr=(lists[i]||[]).filter(function(x){return !watched[x.id]&&!blocked[x.id]});
      arr.forEach(function(x,r){x.s=1/(r+2)+.25*Math.min(1,(authors[x.a]||0)/3)});
      arr.sort(function(a,b){return b.s-a.s});
      return {arr:arr,left:p.slots,total:p.slots,pos:0};
    });
    var out=[],seen={},perAuthor={},guard=0;
    while(out.length<FEED_N&&guard++<600){
      var best=-1,br=-1;
      cols.forEach(function(c,i){if(c.pos<c.arr.length&&c.left>0){var r=c.left/c.total;if(r>br){br=r;best=i}}});
      if(best<0){for(var j=0;j<cols.length;j++)if(cols[j].pos<cols[j].arr.length){best=j;break}}
      if(best<0)break;
      var c=cols[best],x=c.arr[c.pos++];c.left--;
      if(seen[x.id])continue;if((perAuthor[x.a]||0)>=3)continue;
      seen[x.id]=1;perAuthor[x.a]=(perAuthor[x.a]||0)+1;out.push({id:x.id,t:x.t,a:x.a,v:x.v,l:x.l,p:x.p});
    }
    return out;
  }
  function readFeed(){
    try{
      var stored=ls('feed')||'null';
      if(stored.length>200000)return null;
      var f=JSON.parse(stored);
      if(!f||!Array.isArray(f.items))return null;
      var clean=[],seen=Object.create(null);
      for(var i=0;i<Math.min(f.items.length,FEED_N*4)&&clean.length<FEED_N;i++){
        var item=f.items[i];
        if(!item||!validVideoId(item.id)||seen[item.id])continue;
        seen[item.id]=1;
        clean.push({
          id:item.id,t:safeStoredString(item.t,300),a:safeStoredString(item.a,120),
          v:safeStoredNumber(item.v,0,9007199254740991,0),l:safeStoredNumber(item.l,0,1000000000,0),
          p:safeStoredString(item.p,100)
        });
      }
      return clean.length?{ts:safeStoredNumber(f.ts,0,8640000000000000,0),sig:safeStoredString(f.sig,512),items:clean}:null;
    }catch(e){return null}
  }
  function feedSig(h){return h.slice(0,10).map(function(e){return e.i}).join(',')+'|en'}
  function readRecentFeedIds(){
    try{
      var raw=JSON.parse(ls('feedRecentIds')||'[]');
      return Array.isArray(raw)?raw.filter(validVideoId).slice(0,FEED_N*3):[];
    }catch(e){return []}
  }
  function recentFeedSet(){
    var set=Object.create(null);
    readRecentFeedIds().forEach(function(id){set[id]=1});
    return set;
  }
  function rememberFeedItems(items){
    var seen=Object.create(null),all=[];
    (items||[]).forEach(function(item){
      var id=item&&item.id;
      if(validVideoId(id)&&!seen[id]){seen[id]=1;all.push(id)}
    });
    readRecentFeedIds().forEach(function(id){
      if(!seen[id]){seen[id]=1;all.push(id)}
    });
    try{ls('feedRecentIds',JSON.stringify(all.slice(0,FEED_N*3)))}catch(e){}
  }
  function drawFeed(items){
    lastFeed=items.slice();browseItems=lastFeed;feedSeen=Object.create(null);rememberFeedItems(lastFeed);
    var f=$('feed'),frag=document.createDocumentFragment();f.textContent='';
    items.forEach(function(it,i){feedSeen[it.id]=1;frag.appendChild(makeCard(it,i,lastFeed))});f.appendChild(frag);
    var has=feedHistory().length>0;$('feedTitle').textContent=tr(has?'forYou':'popular');$('feedHint').textContent=tr(personalizeFeed?'feedHint':'feedHintOff');$('feedHint').hidden=has;
    drawHistory();
  }
  function appendFeedItems(items){
    var fresh=[];(items||[]).forEach(function(it){if(it&&it.id&&!feedSeen[it.id]){feedSeen[it.id]=1;fresh.push(it)}});
    if(!fresh.length)return 0;
    var frag=document.createDocumentFragment(),startIndex=lastFeed.length;
    fresh.forEach(function(it){lastFeed.push(it)});
    fresh.forEach(function(it,i){frag.appendChild(makeCard(it,startIndex+i,lastFeed))});
    $('feed').appendChild(frag);browseItems=lastFeed;rememberFeedItems(lastFeed);return fresh.length;
  }
  function setMoreLoading(kind,on,label){
    var el=$(kind==='feed'?'feedLoading':'resultsLoading');if(el)el.hidden=!on;
    if(kind==='feed'&&label){var text=$('feedLoadingText');if(text)text.textContent=label}
  }
  function setFeedRefreshBusy(on){
    var b=$('feedRefresh');if(!b)return;
    b.disabled=!!on;b.setAttribute('aria-busy',on?'true':'false');
  }
  function fetchFeedPage(page,seq,append,loadingLabel,forceFresh){
    if(feedLoading)return;
    feedLoading=true;setMoreLoading('feed',true,loadingLabel||tr('loadingMore'));
    if(!append)setFeedRefreshBusy(true);
    var h=feedHistory(),excluded=forceFresh?recentFeedSet():null;
    var collected=feedPlan.map(function(){return []}),feedErrors=[],pagesTried=0,maxExtraPages=forceFresh?2:0;
    function requestPage(targetPage){
      // Query feed topics one at a time so a new page load does not burst the
      // public providers with four simultaneous requests from one Worker.
      function runTopic(index){
        if(index>=feedPlan.length)return Promise.resolve();
        return searchQ(feedPlan[index].q,targetPage).then(function(list){
          if(Array.isArray(list))collected[index]=collected[index].concat(list);
          return runTopic(index+1);
        }).catch(function(err){
          feedErrors.push(err);
          // All providers failed for this query; stop the remaining topics instead
          // of hammering the same API endpoints with requests that will also fail.
        });
      }
      return runTopic(0).then(function(){
        var available=mergeFeed(feedPlan,collected,h,excluded);
        if(forceFresh&&available.length<FEED_N&&pagesTried<maxExtraPages&&!feedErrors.length){
          pagesTried++;
          return requestPage(page+pagesTried);
        }
        return {items:available,page:targetPage,lists:collected,errors:feedErrors};
      });
    }
    requestPage(page).then(function(result){
      if(seq!==feedSeq)return;
      var items=result.items;
      if(!items.length&&forceFresh&&excluded){
        items=mergeFeed(feedPlan,result.lists,h,null);
      }
      var added=0;
      if(append)added=appendFeedItems(items);else{drawFeed(items);added=items.length}
      feedPage=result.page;
      feedHasMore=result.lists.some(function(a){return a.length>0})&&(!append||added>0);
      feedLoading=false;setMoreLoading('feed',false);
      if(!append)setFeedRefreshBusy(false);
      recheckSentinel('feedSentinel');
      if(!items.length&&!lastFeed.length)feedMsg(tr('feedFail')+(result.errors&&result.errors.length?' ('+apiErrorText(result.errors[0])+')':''));
      else if(!privacyMode&&!append&&items.length){
        try{ls('feed',JSON.stringify({ts:Date.now(),sig:feedSig(feedHistory()),items:items}))}catch(e){}
      }
    }).catch(function(err){
      if(seq!==feedSeq)return;
      feedLoading=false;setMoreLoading('feed',false);
      if(!append)setFeedRefreshBusy(false);
      if(!lastFeed.length)feedMsg(tr('feedFail')+' ('+apiErrorText(err)+')');
    });
  }
  function loadMoreFeed(){
    if(feedLoading||!feedHasMore||!feedPlan.length||!$('feedWrap')||$('feedWrap').hidden)return;
    fetchFeedPage(feedPage+1,feedSeq,true,tr('loadingMore'),false);
  }
  function renderHome(force){
    var h=feedHistory(),cache=force||privacyMode?null:readFeed(),seq=++feedSeq;
    feedLoading=false;setMoreLoading('feed',false);feedHasMore=true;feedPage=1;feedSeen=Object.create(null);
    if(force){lastFeed=[];browseItems=[]}
    if(!force&&cache&&cache.items.length)drawFeed(cache.items);else drawSkeleton();
    feedCursor=(+ls('feedCursor')||0)+1;ls('feedCursor',String(feedCursor));
    var rotation=((feedCursor-1)%4)+1;
    feedPlan=planFor(h,rotation);
    feedNextPages=Object.create(null);
    fetchFeedPage(1,seq,false,force?tr('refreshingFeed'):tr('loadingFeed'),!!force);
  }
  function drawSkeleton(){
    var f=$('feed');f.textContent='';
    for(var i=0;i<4;i++){
      var c=document.createElement('div');c.className='vcard sk';
      var thumb=document.createElement('span');thumb.className='thumb';
      var meta=document.createElement('span');meta.className='vmeta';
      meta.appendChild(document.createElement('b'));meta.appendChild(document.createElement('small'));
      c.appendChild(thumb);c.appendChild(meta);f.appendChild(c);
    }
  }
  function feedMsg(text){
    var f=$('feed');f.textContent='';var p=document.createElement('p');p.className='note';p.textContent=text;
    var b=document.createElement('button');b.type='button';b.className='chip';b.style.marginTop='10px';b.textContent=tr('retry');b.onclick=function(){renderHome(true)};
    var w=document.createElement('div');w.appendChild(p);w.appendChild(b);
    f.appendChild(w);
  }
  function showResults(on){
    $('resultsWrap').hidden=!on;$('feedWrap').hidden=on;
    setMoreLoading('feed',!on&&feedLoading);setMoreLoading('results',on&&searchLoading);
    $('historyWrap').hidden=on||privacyMode||!getHist().length;
    if(!on){$('searchStatus').textContent='';$('results').textContent='';activeChip='home';browseItems=lastFeed||[]}
    markChip();
  }
  function renderChips(){
    var n=$('chips');n.textContent='';
    var all=[['home',tr('forYou'),'']].concat(TOPICS.map(function(t){return [t[0],t[0],t[1]]}));
    all.forEach(function(t){var b=document.createElement('button');b.type='button';b.className='chip';b.dataset.k=t[0];b.dataset.q=t[2];b.textContent=t[1];n.appendChild(b)});
    markChip();
  }
  function markChip(){
    var on=$('resultsWrap').hidden?'home':activeChip;
    $('chips').querySelectorAll('.chip').forEach(function(c){c.classList.toggle('on',c.dataset.k===on)});
  }
  $('chips').addEventListener('click',function(e){
    var b=e.target.closest('.chip');if(!b)return;
    if(b.dataset.k==='home'){$('searchInput').value='';if(linkMode)setLinkMode(false);showResults(false)}
    else{activeChip=b.dataset.k;if(linkMode)setLinkMode(false);$('searchInput').value=b.dataset.q;searchVideos(b.dataset.q)}
  });
  $('feedRefresh').onclick=function(){renderHome(true)};
  $('resClose').onclick=function(){$('searchInput').value='';showResults(false)};
  $('historyToggle').onclick=function(){historyExpanded=!historyExpanded;drawHistory()};
  $('histClear').onclick=function(){
    if(!confirm(tr('clearAsk')))return;
    historyEpoch++;
    ls('hist','[]');historyExpanded=false;ls('feed','');ls('feedRecentIds','[]');ls('feedCursor','0');feedCursor=0;
    try{localStorage.removeItem('malektube:v2:txt');localStorage.removeItem('txt')}catch(e){}
    try{
      for(var i=localStorage.length-1;i>=0;i--){
        var key=localStorage.key(i);
        if(key&&(key.indexOf('malektube:v2:t:')===0||(key.indexOf('t:')===0&&key.length===13)))localStorage.removeItem(key);
      }
    }catch(e){}
    ls('titleKeys','[]');T={};videoInfoCache=Object.create(null);videoInfoCacheOrder=[];
    drawHistory();feedSeen=Object.create(null);renderHome(true);
  };
  function updatePrivacyControl(){
    var p=$('privacyToggle');
    if(p){
      p.textContent=privacyMode?'Private mode: On':'Private mode: Off';
      p.setAttribute('aria-pressed',privacyMode?'true':'false');
    }
  }
  function setPrivacyMenu(open){
    var menu=$('privacyMenu'),button=$('privacyMenuButton');
    if(!menu||!button)return;
    menu.hidden=!open;
    button.setAttribute('aria-expanded',open?'true':'false');
  }
  $('privacyMenuButton').addEventListener('click',function(event){
    event.preventDefault();event.stopPropagation();
    setPrivacyMenu($('privacyMenu').hidden);
  });
  $('privacyMenu').addEventListener('click',function(event){event.stopPropagation()});
  document.addEventListener('click',function(event){
    if(!$('homeTools').contains(event.target))setPrivacyMenu(false);
  });
  document.addEventListener('keydown',function(event){
    if(event.key==='Escape'&&!$('privacyMenu').hidden){
      setPrivacyMenu(false);$('privacyMenuButton').focus();
    }
  });
  $('privacyToggle').addEventListener('click',function(){
    privacyMode=!privacyMode;historyEpoch++;ls('privacyMode',privacyMode?'1':'0');
    updatePrivacyControl();drawHistory();renderHome(true);
  });
  updatePrivacyControl();
  function updatePersonalizeControl(){
    var p=$('personalizeToggle');
    if(!p)return;
    p.textContent=personalizeFeed?'Personalized feed: On':'Personalized feed: Off';
    p.setAttribute('aria-pressed',personalizeFeed?'true':'false');
  }
  $('personalizeToggle').addEventListener('click',function(){
    personalizeFeed=!personalizeFeed;ls('personalize',personalizeFeed?'1':'0');
    ls('feed','');updatePersonalizeControl();renderHome(true);
  });
  updatePersonalizeControl();
  $('searchInput').addEventListener('input',function(){if(!this.value.trim())showResults(false)});

  function pump(){while(active<3&&q.length){var id=q.shift();active++;fetchTitle(id,function(){active--;pump()})}}
  function buildList(){
    var rows=$('rows');rows.textContent='';
    if(io){io.disconnect();io=null}
    if(currentTab==='recommendations'){loadRecommendations();return}
    var listItems=playlistIds.length?playlistIds:ids;
    if(!listItems.length){showListMessage(tr('listWait'));return}
    var frag=document.createDocumentFragment();
    listItems.forEach(function(id,i){
      var r=document.createElement('div');r.className='row'+(id===currentVideoId?' cur':'');r.dataset.id=id;r.dataset.i=i;
      var n=document.createElement('i');n.textContent=i+1;
      var im=document.createElement('img');im.loading='lazy';im.decoding='async';im.alt='';im.src=thumbnailUrl(id);
      var sp=document.createElement('span');sp.textContent=title(id)||(tr('video')+' '+(i+1));
      r.appendChild(n);r.appendChild(im);r.appendChild(sp);frag.appendChild(r);
    });
    rows.appendChild(frag);
    io=new IntersectionObserver(function(es){es.forEach(function(en){
      if(!en.isIntersecting)return;io.unobserve(en.target);
      var id=en.target.dataset.id;if(!title(id)&&q.indexOf(id)<0){q.push(id);pump()}
    })},{root:rows,rootMargin:'200px'});
    rows.querySelectorAll('.row').forEach(function(r){io.observe(r)});
  }
  function setIds(a){
    if(customQueueActive)return;
    var safe=Array.isArray(a)?a.filter(validVideoId):[];
    ids=safe.slice();
    if(!preserveSavedPlaylist)playlistIds=safe.slice();
    if($('list').classList.contains('open')&&currentTab==='playlist')buildList();
  }
  function setCur(i){cur=i;var rs=$('rows'),o=rs.querySelector('.cur');if(o)o.classList.remove('cur');var n=rs.querySelector('[data-i="'+i+'"]');if(n&&currentTab==='playlist')n.classList.add('cur')}
  function closeList(){$('list').classList.remove('open')}
  function switchListTab(tab){
    currentTab=tab;
    $('tabPlaylist').classList.toggle('on',tab==='playlist');$('tabRecommendations').classList.toggle('on',tab==='recommendations');
    $('tabPlaylist').setAttribute('aria-selected',tab==='playlist'?'true':'false');$('tabRecommendations').setAttribute('aria-selected',tab==='recommendations'?'true':'false');
    buildList();
  }
  function ls(k,v){
    var key='malektube:v2:'+k;
    try{
      if(v===undefined){
        var value=localStorage.getItem(key);
        if(value===null){value=localStorage.getItem(k);if(value!==null){localStorage.setItem(key,value);localStorage.removeItem(k)}}
        return value;
      }
      localStorage.setItem(key,v);return v;
    }catch(e){return null}
  }
  try{localStorage.removeItem('malektube:v2:txt');localStorage.removeItem('txt')}catch(e){}
  function parse(s){
    var vids=[],list=null;
    (s||'').split(/[\s,]+/).filter(Boolean).forEach(function(l){
      var m=l.match(/[?&]list=([\w-]+)/),v=l.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
      if(m){if(!list)list=m[1];return}
      if(v){if(vids.indexOf(v[1])<0)vids.push(v[1]);return}
      if(/^[\w-]{11}$/.test(l)&&vids.indexOf(l)<0)vids.push(l);
      else if(/^(PL|UU|OL|RD|LL)[\w-]{10,}$/.test(l)&&!list)list=l;
    });
    return (list||vids.length)?{list:list,vids:vids}:null;
  }
  function setPlayerStatus(mode,errorCode){
    var box=$('playerStatus'),spinner=box.querySelector('.load-spinner'),label=$('playerStatusText'),open=$('playerOpenYoutube');
    if(!mode||mode==='blocked'){box.hidden=true;if(open)open.hidden=true;return}
    box.hidden=false;spinner.hidden=mode!=='loading';
    if(mode==='embedBlocked'){
      label.textContent='This video cannot be played inside an embedded player.';
    }else if(mode==='error'&&Number(errorCode)===153){
      label.textContent='YouTube did not receive this site’s Referer identity (error 153).';
    }else if(mode==='error'&&Number(errorCode)===100){
      label.textContent='This video may be private, removed, or unavailable.';
    }else if(mode==='error'&&Number(errorCode)===5){
      label.textContent='YouTube could not play this video in the current HTML5 player (error 5).';
    }else if(mode==='error'&&Number.isFinite(Number(errorCode))){
      label.textContent='YouTube playback error code: '+Number(errorCode)+'.';
    }else{
      label.textContent=tr(mode==='loading'?'playerLoading':mode==='blocked'?'playerTap':'playerError');
    }
    if(open){
      var showYoutubeFallback=mode==='embedBlocked'||mode==='error'||mode==='blocked';
      open.href='https://www.youtube.com/watch?v='+encodeURIComponent(currentVideoId);
      open.hidden=!showYoutubeFallback||!currentVideoId;
    }
  }
  function cmd(f,a){
    try{
      if(!yt.contentWindow)return false;
      yt.contentWindow.postMessage(JSON.stringify({event:'command',func:f,args:a||[]}), 'https://www.youtube.com');
      return true;
    }catch(e){return false}
  }
  function listen(token){
    token=token||playerLoadToken;
    [0,350,800,1400,2200].forEach(function(delay){
      setTimeout(function(){
        if(token!==playerLoadToken||stage.hidden)return;
        try{yt.contentWindow.postMessage(JSON.stringify({event:'listening',id:1,channel:'widget'}),'https://www.youtube.com')}catch(e){}
        cmd('addEventListener',['onAutoplayBlocked']);
        cmd('addEventListener',['onError']);
        cmd('addEventListener',['onStateChange']);
        if(playerWantsPlay&&!playerHasStarted){
          setTimeout(function(){if(token===playerLoadToken&&playerWantsPlay&&!playerHasStarted)cmd('playVideo')},120);
        }
      },delay);
    });
    clearTimeout(playerStartTimer);
    playerStartTimer=setTimeout(function(){
      if(token===playerLoadToken&&!playerHasStarted&&stage&&!stage.hidden){
        playerWantsPlay=false;playing=false;setPlayerStatus('blocked');updatePlayButton();
      }
    },10000);
  }
  window.addEventListener('message',function(e){
    if(e.source!==yt.contentWindow||e.origin!=='https://www.youtube.com')return;
    var d;try{d=JSON.parse(e.data)}catch(x){return}
    if(d.event==='onAutoplayBlocked'){
      clearTimeout(playerStartTimer);playerWantsPlay=false;playing=false;
      setPlayerStatus('blocked');updatePlayButton();return;
    }
    if(d.event==='onError'){
      clearTimeout(playerStartTimer);playerWantsPlay=false;playing=false;
      var playerErrorCode=Number(d.info&&typeof d.info==='object'?(d.info.errorCode||d.info.code):d.info);
      setPlayerStatus(playerErrorCode===101||playerErrorCode===150?'embedBlocked':'error',playerErrorCode);
      updatePlayButton();return;
    }
    var s=d.event==='onStateChange'?d.info:(d.info&&d.info.playerState);
    if(s===1){
      var clockWasRunning=progressClockRunning;
      playerHasStarted=true;playerWantsPlay=false;clearTimeout(playerStartTimer);setPlayerStatus('');
      playing=true;progressClockRunning=true;
      if(!clockWasRunning){lastClockAt=Date.now();lastRemoteTimeAt=lastClockAt}
      cmd('unloadModule',['captions']);cmd('unloadModule',['cc']);
      startProgressPolling(playerLoadToken);revealControls();
    }else if(s===2||s===3){
      progressClockRunning=false;lastClockAt=Date.now();
      if(s===2){playing=false;clearTimeout(controlsHideTimer);stage.classList.remove('controls-hidden')}
      if(s===2&&!playerHasStarted&&playerWantsPlay)setPlayerStatus('blocked');
    }else if(s===0){
      progressClockRunning=false;playing=false;clearTimeout(controlsHideTimer);stage.classList.remove('controls-hidden');
    }
    updatePlayButton();
    if(s===1)resumePendingVideo();
    var inf=d.info;
    if(inf&&typeof inf==='object'){
      if(!customQueueActive&&inf.playlist&&inf.playlist.length&&(inf.playlist.length!==ids.length||inf.playlist[0]!==ids[0]||inf.playlist[inf.playlist.length-1]!==ids[ids.length-1]))setIds(inf.playlist);
      if(inf.videoData&&inf.videoData.video_id){
        var activeId=inf.videoData.video_id;
        if(requestedStartId&&activeId!==requestedStartId){
          if(!startCorrectionSent){
            startCorrectionSent=true;
            if(customQueueActive)cmd('loadVideoById',[requestedStartId,0]);
            else if(requestedStartQueue.length)cmd('loadPlaylist',[requestedStartQueue,0,0]);
          }
          return;
        }
        setCurrentVideo(activeId,inf.videoData.title||'');
        if(activeId===requestedStartId){requestedStartId='';requestedStartQueue=[];startCorrectionSent=false}
        if(customQueueActive){
          var activeQueueIndex=customQueueIds.indexOf(activeId);
          if(activeQueueIndex>=0&&activeQueueIndex!==customQueueIndex){customQueueIndex=activeQueueIndex;cur=activeQueueIndex;}
        }
        resumePendingVideo();
      }
      if(typeof inf.duration==='number'&&Number.isFinite(inf.duration)&&inf.duration>0){dur=inf.duration;if(!drag)paint(tcur)}
      if(typeof inf.currentTime==='number'&&Number.isFinite(inf.currentTime)&&inf.currentTime>=0){
        tcur=inf.currentTime;lastRemoteTimeAt=Date.now();lastClockAt=lastRemoteTimeAt;
        if(!drag)paint(tcur);saveHistoryProgress();
      }
      if(!customQueueActive&&typeof inf.playlistIndex==='number'&&inf.playlistIndex!==cur)setCur(inf.playlistIndex);
    }
    if(s===1)lastAutoAdvanceId='';
    if(s===0&&playerHasStarted&&currentVideoId&&!requestedStartId&&lastAutoAdvanceId!==currentVideoId){
      var endedId=currentVideoId,endedToken=playerLoadToken;
      lastAutoAdvanceId=endedId;clearTimeout(customAdvanceTimer);
      if(!autoplayEnabled){
        cmd('seekTo',[0,true]);cmd('playVideo');
      }else if(customQueueActive&&customQueueIds.length>1){
        customAdvanceTimer=setTimeout(function(){
          if(endedToken===playerLoadToken&&currentVideoId===endedId&&!playing&&!requestedStartId)go(1);
        },320);
      }
    }
  });
  function rot(){return stage.classList.contains('land')&&window.innerHeight>window.innerWidth}
  function hmsg(t){var h=$('hint');h.textContent=t;h.style.opacity=1;clearTimeout(hmsg.t);hmsg.t=setTimeout(function(){h.style.opacity=0},2600)}
  function lockL(){try{var o=screen.orientation;if(o&&o.lock){var r=o.lock('landscape');if(r&&r.catch)r.catch(function(){})}}catch(x){}}
  function land(on){
    if(typeof on!=='boolean')on=!stage.classList.contains('land');
    var was=stage.classList.contains('land');if(was===on)return;
    stage.classList.toggle('land',on);updatePlayerModeButtons();
    if(on){var r=fs(true);if(r&&r.then)r.then(lockL,lockL);else lockL();setTimeout(function(){if(rot())hmsg(tr('rotate'))},400)}
    else{fs(false);try{if(screen.orientation&&screen.orientation.unlock)screen.orientation.unlock()}catch(x){}hmsg(tr('normal'))}
  }
  function updatePlayerModeButtons(){
    var zoom=$('b-zoom'),rotate=$('b-rotate'),rotated=stage.classList.contains('land');
    if(zoom){
      var zoomLabel=fill?'Return to normal video size':'Shorts-style zoom';
      zoom.classList.toggle('on',fill);
      zoom.setAttribute('aria-pressed',fill?'true':'false');
      zoom.setAttribute('aria-label',zoomLabel);zoom.title=zoomLabel;
    }
    if(rotate){
      var rotateLabel=rotated?'Return to normal orientation':'Rotate screen to landscape';
      rotate.classList.toggle('on',rotated);
      rotate.setAttribute('aria-pressed',rotated?'true':'false');
      rotate.setAttribute('aria-label',rotateLabel);rotate.title=rotateLabel;
    }
  }
  function setZoomMode(on){
    fill=!!on;slide.className=fill?'fill':'fit';
    ls('fill',fill?'1':'0');updatePlayerModeButtons();
  }
  function fs(on){try{var d=document,e=d.documentElement;if(on){if(!d.fullscreenElement&&e.requestFullscreen){var r=e.requestFullscreen({navigationUI:'hide'});if(r&&r.catch)r.catch(function(){});return r}}else if(d.fullscreenElement&&d.exitFullscreen)d.exitFullscreen()}catch(x){}}
  function start(p,keepSavedPlaylist){
    (p.vids||[]).forEach(function(id){delete historyDeleted[id]});
    if(!p||(!p.list&&(!Array.isArray(p.vids)||!p.vids.some(validVideoId))))return;
    if(!p.list)p.vids=p.vids.filter(validVideoId);
    if(!p.list&&!p.vids.length)return;
    if(pendingResumeId&&(!p.vids||p.vids[0]!==pendingResumeId)){pendingResumeId='';pendingResumeAt=0}
    if(currentVideoId)recordHistory(currentVideoId);
    clearTimeout(histTimer);clearInterval(progressPollTimer);clearTimeout(controlsHideTimer);clearTimeout(customAdvanceTimer);
    dur=0;tcur=0;lastSec=-1;historySaveAt=0;progressClockRunning=false;lastClockAt=0;lastRemoteTimeAt=0;
    lastAutoAdvanceId='';currentDurationHint=Number(p.durationHint)||0;
    customQueueActive=!p.list;customQueueIds=p.list?[]:p.vids.slice();customQueueIndex=p.list?-1:0;
    stage.classList.remove('controls-hidden');
    $('pf').style.transform='scaleX(0)';$('tmCurrent').textContent='0:00';$('tmDuration').textContent='0:00';hideSeekPreview();
    preserveSavedPlaylist=!!keepSavedPlaylist;
    playerLoadToken++;var activeLoadToken=playerLoadToken;
    clearTimeout(playerStartTimer);playerHasStarted=false;playerWantsPlay=true;
    playing=false;setPlayerStatus('loading');
    $('setup').hidden=true;stage.hidden=false;
    ids=p.list?[]:p.vids.slice();cur=p.list?-1:0;
    if(!preserveSavedPlaylist){
      originalPlaylistId=p.list||null;
      playlistIds=p.list?[]:p.vids.slice();
    }
    requestedStartId=p.list?'':p.vids[0];
    requestedStartQueue=p.list?[]:p.vids.slice();
    startCorrectionSent=false;
    currentVideoId='';recommendedVideos=[];recommendedFor='';
    playing=false;
    var q='autoplay=1&controls=0&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3&disablekb=1&fs=0&loop=1&vq=tiny&cc_load_policy=0&enablejsapi=1';
    var b='https://www.youtube.com/embed/';
    var ref='';try{if(/^https?:/.test(location.href))ref='&origin='+encodeURIComponent(location.origin)}catch(e){}
    q+=ref;
    yt.onload=function(){if(activeLoadToken===playerLoadToken)listen(activeLoadToken)};
    yt.onerror=function(){
      if(activeLoadToken===playerLoadToken){
        clearTimeout(playerStartTimer);playerWantsPlay=false;playing=false;
        setPlayerStatus('error');updatePlayButton();
      }
    };
    var singleVideoLoop=!p.list&&p.vids.length===1?'&playlist='+encodeURIComponent(p.vids[0]):'';
    yt.src=p.list?b+'videoseries?list='+encodeURIComponent(p.list)+'&'+q:b+p.vids[0]+'?'+q+singleVideoLoop;
    playerStartTimer=setTimeout(function(){
      if(activeLoadToken===playerLoadToken&&!playerHasStarted&&!stage.hidden){
        playerWantsPlay=false;playing=false;setPlayerStatus('blocked');updatePlayButton();
      }
    },14000);
    if($('list').classList.contains('open'))buildList();
    $('hint').textContent=tr('hint');$('hint').style.opacity=1;updatePlayButton();paint(0);
    setTimeout(function(){$('hint').style.opacity=0},3500);
  }
  function stop(){
    var endingId=currentVideoId;
    var save=endingId?recordHistory(endingId):Promise.resolve();
    currentVideoId='';clearTimeout(histTimer);clearTimeout(playerStartTimer);clearInterval(progressPollTimer);clearTimeout(controlsHideTimer);clearTimeout(customAdvanceTimer);
    playerLoadToken++;playerWantsPlay=false;playerHasStarted=false;playing=false;progressClockRunning=false;
    customQueueActive=false;customQueueIds=[];customQueueIndex=-1;currentDurationHint=0;
    setPlayerStatus('');stage.classList.remove('controls-hidden');
    yt.src='about:blank';stage.hidden=true;$('setup').hidden=false;closeList();fs(false);stage.classList.remove('land');fill=false;slide.className='fit';ls('fill','0');updatePlayerModeButtons();try{screen.orientation.unlock()}catch(x){}
    if(browseView==='feed')renderHome(true);
    drawHistory();restoreBrowseState();
    save.then(function(){
      var currentScroll=window.scrollY||document.documentElement.scrollTop||0;
      drawHistory();
      if(browseView==='feed')renderHome(true);
      window.scrollTo(0,currentScroll);
    },function(){});
  }
  function customQueueStep(dir){
    if(!customQueueActive||!customQueueIds.length)return false;
    var total=customQueueIds.length,index=customQueueIds.indexOf(currentVideoId);
    if(index<0)index=Math.max(0,Math.min(total-1,customQueueIndex));
    var nextIndex;
    nextIndex=(index+dir+total)%total;
    var target=customQueueIds[nextIndex];
    if(!validVideoId(target))return false;
    customQueueIndex=nextIndex;cur=nextIndex;
    requestedStartId=target;requestedStartQueue=customQueueIds.slice(nextIndex);startCorrectionSent=false;
    cmd('loadVideoById',[target,0]);
    return true;
  }
  function go(dir){
    if(busy)return;busy=true;
    slide.style.transition='transform .2s ease,opacity .2s ease';
    slide.style.transform='translateY('+(dir>0?-18:18)+'%)';slide.style.opacity='0';
    setTimeout(function(){
      if(!customQueueStep(dir))cmd(dir>0?'nextVideo':'previousVideo');
      playing=true;progressClockRunning=true;lastClockAt=Date.now();updatePlayButton();
      slide.style.transition='none';
      slide.style.transform='translateY('+(dir>0?18:-18)+'%)';
      void slide.offsetWidth;
      slide.style.transition='transform .22s ease,opacity .22s ease';
      slide.style.transform='translateY(0)';slide.style.opacity='1';
      revealControls();
      setTimeout(function(){busy=false},230);
    },200);
  }
  function toggle(){
    revealControls();
    if(playing){cmd('pauseVideo');playing=false;setInlineIcon(flash,'pause')}
    else{
      playerWantsPlay=true;setPlayerStatus('loading');cmd('playVideo');playing=true;setInlineIcon(flash,'play');
    }
    updatePlayButton();
    if(playing)revealControls();else{clearTimeout(controlsHideTimer);stage.classList.remove('controls-hidden')}
    flash.classList.add('show');setTimeout(function(){flash.classList.remove('show')},450);
  }
  // While the player is open, the browser must treat a long press as a
  // player gesture, never as a request to select page text or open a callout.
  function blockPlayerSelection(e){
    if(stage.hidden)return;
    if(e.cancelable)e.preventDefault();
  }
  document.addEventListener('selectstart',blockPlayerSelection,true);
  document.addEventListener('contextmenu',blockPlayerSelection,true);
  document.addEventListener('dragstart',blockPlayerSelection,true);
  document.addEventListener('selectionchange',function(){
    if(stage.hidden)return;
    var selection=window.getSelection();
    if(selection&&selection.rangeCount)selection.removeAllRanges();
  });

  var gestureStart=null;
  var t=$('touch');
  t.addEventListener('pointerdown',function(e){
    if(e.pointerType==='mouse'&&e.button!==0)return;
    // Cancel the browser's native touch-selection/callout default, but keep
    // the Pointer Events stream and our manual tap/swipe handling intact.
    if(e.pointerType!=='mouse'&&e.cancelable)e.preventDefault();
    gestureStart={id:e.pointerId,x:e.clientX,y:e.clientY,at:Date.now()};
    try{t.setPointerCapture(e.pointerId)}catch(x){}
  },{passive:false});
  t.addEventListener('pointerup',function(e){
    var g=gestureStart;if(!g||g.id!==e.pointerId)return;gestureStart=null;
    var dx=e.clientX-g.x,dy=e.clientY-g.y;
    if(rot()){var tx=dx;dx=dy;dy=-tx}
    if(Math.abs(dy)>50&&Math.abs(dy)>Math.abs(dx))go(dy<0?1:-1);
    else if(Math.abs(dy)<12&&Math.abs(dx)<12&&Date.now()-g.at<500)tap(rot()?e.clientY:e.clientX);
  });
  t.addEventListener('pointercancel',function(){gestureStart=null});
  $('ui').addEventListener('click',function(e){if(e.target.closest('button')&&e.target.id!=='b-back')revealControls()});
  $('controlsDock').addEventListener('click',function(e){if(e.target.closest('button'))revealControls();else if(!e.target.closest('#trk'))tap(rot()?e.clientY:e.clientX)});
  $('b-toggle').onclick=toggle;
  $('b-back').onclick=stop;
  $('b-rotate').onclick=function(){land(!stage.classList.contains('land'))};
  $('b-zoom').onclick=function(){setZoomMode(!fill)};
  $('b-autoplay').onclick=function(){autoplayEnabled=!autoplayEnabled;ls('autoplay',autoplayEnabled?'1':'0');updateAutoplayButton();hmsg(tr(autoplayEnabled?'autoplayEnabled':'autoplayDisabled'))};
  updateAutoplayButton();
  function run(txt){
    txt=String(txt||'').slice(0,2048);$('url').value=txt;
    var p=parse(txt);
    if(!p){$('err').textContent=tr('bad');return}
    $('err').textContent='';start(p);
  }
  $('paste').onclick=function(){
    if(!navigator.clipboard||!navigator.clipboard.readText){$('err').textContent=tr('noclip');return}
    navigator.clipboard.readText().then(function(t){$('url').value=t;run(t)},function(){$('err').textContent=tr('clipdeny')});
  };
  function recheckSentinel(id){
    if(!moreObserver)return;
    var node=$(id);if(!node)return;
    moreObserver.unobserve(node);moreObserver.observe(node);
  }
  function initInfiniteScroll(){
    if('IntersectionObserver' in window){
      moreObserver=new IntersectionObserver(function(entries){
        entries.forEach(function(entry){
          if(!entry.isIntersecting)return;
          if(entry.target.id==='feedSentinel'&&!$('feedWrap').hidden)loadMoreFeed();
          if(entry.target.id==='resultsSentinel'&&!$('resultsWrap').hidden)loadMoreSearch();
        });
      },{root:null,rootMargin:'900px 0px'});
      moreObserver.observe($('feedSentinel'));moreObserver.observe($('resultsSentinel'));
    }else{
      var scrollQueued=false;
      window.addEventListener('scroll',function(){
        if(scrollQueued)return;scrollQueued=true;
        requestAnimationFrame(function(){scrollQueued=false;
          if(window.innerHeight+window.scrollY>document.documentElement.scrollHeight-900){
            if(!$('resultsWrap').hidden)loadMoreSearch();else loadMoreFeed();
          }
        });
      },{passive:true});
    }
  }
  initInfiniteScroll();
  purgeExpiredHistory();
  renderChips();renderHome(false);drawHistory();
  var launchUrl=new URL(location.href),launchValue=launchUrl.searchParams.get('u');
  fill=false;slide.className='fit';ls('fill','0');updatePlayerModeButtons();
  if(launchValue!==null){
    $('url').value=launchValue;
    launchUrl.searchParams.delete('u');
    history.replaceState(null,'',launchUrl.pathname+launchUrl.search+launchUrl.hash);
    run(launchValue);
  }
  $('b-aud').onclick=function(){var on=stage.classList.toggle('aud');this.classList.toggle('on',on);ls('aud',on?'1':'0');if(on)cmd('setPlaybackQuality',['tiny'])};
  if(ls('aud')==='1'){stage.classList.add('aud');$('b-aud').classList.add('on')}
  $('b-list').onclick=function(){switchListTab('playlist');$('list').classList.add('open');var c=$('rows').querySelector('.cur');if(c)c.scrollIntoView({block:'center'})};
  $('tabPlaylist').onclick=function(){switchListTab('playlist')};
  $('tabRecommendations').onclick=function(){switchListTab('recommendations')};
  $('lclose').onclick=closeList;
  var trk=$('trk');
  function tpos(e){var r=trk.getBoundingClientRect();var u=rot()?(e.clientY-r.top)/Math.max(1,r.height):(e.clientX-r.left)/Math.max(1,r.width);return Math.max(0,Math.min(1,u))*dur}
  trk.addEventListener('pointerdown',function(e){
    e.preventDefault();
    if(!dur)return;
    drag=true;trk.classList.add('dragging');
    try{trk.setPointerCapture(e.pointerId)}catch(x){}
    showSeekPreview(e);paint(tpos(e));
  },{passive:false});
  trk.addEventListener('pointermove',function(e){
    if(drag)paint(tpos(e));
    showSeekPreview(e);
  });
  trk.addEventListener('pointerenter',function(e){showSeekPreview(e)});
  trk.addEventListener('pointerup',function(e){
    if(!drag)return;
    var target=tpos(e);drag=false;trk.classList.remove('dragging');
    seek(target);hideSeekPreview();scheduleControlsHide();
  });
  trk.addEventListener('pointercancel',function(){drag=false;trk.classList.remove('dragging');hideSeekPreview()});
  trk.addEventListener('pointerleave',function(){if(!drag)hideSeekPreview()});
  trk.addEventListener('lostpointercapture',function(){if(drag){drag=false;trk.classList.remove('dragging')}hideSeekPreview()});

  $('rows').addEventListener('click',function(e){
    var r=e.target.closest('.row');if(!r)return;
    if(r.dataset.rec==='1') {
      var rid=r.dataset.id;saveTitle(rid,r.querySelector('span span')?r.querySelector('span span').textContent:tr('video'));
      start({list:null,vids:[rid],durationHint:+r.dataset.duration||0},true);closeList();return;
    }
    var listItems=playlistIds.length?playlistIds:ids,chosenId=r.dataset.id,index=listItems.indexOf(chosenId);
    if(index<0)return;
    preserveSavedPlaylist=false;ids=listItems.slice();cur=index;
    requestedStartId=chosenId;requestedStartQueue=listItems.slice(index);startCorrectionSent=false;
    if(customQueueActive){
      customQueueIds=listItems.slice();customQueueIndex=index;
      cmd('loadVideoById',[chosenId,0]);
    }else if(originalPlaylistId)cmd('loadPlaylist',[originalPlaylistId,index,0]);
    else if(listItems.length>1)cmd('loadPlaylist',[listItems,index,0]);
    else cmd('loadVideoById',[chosenId,0]);
    playing=true;updatePlayButton();closeList();
  });
})();

// Browsers that enforce Trusted Types treat a service-worker URL as a script URL, so
// it must pass through a policy. The only policy this page defines (see the CSP
// "trusted-types mtube-sw" directive) accepts exactly this origin's own sw.js and
// nothing else; it cannot create HTML or script text.
(function registerServiceWorker(){
  if(!('serviceWorker' in navigator))return;
  var swUrl='sw.js?v=71';
  if(window.trustedTypes&&window.trustedTypes.createPolicy){
    try{
      swUrl=window.trustedTypes.createPolicy('mtube-sw',{createScriptURL:function(value){
        var target=new URL(value,location.href);
        if(target.origin!==location.origin||target.pathname!==new URL('sw.js',location.href).pathname)throw new TypeError('Blocked script URL');
        return target.href;
      }}).createScriptURL(swUrl);
    }catch(e){return}
  }
  navigator.serviceWorker.register(swUrl,{updateViaCache:'none'}).catch(function(){});
})();
