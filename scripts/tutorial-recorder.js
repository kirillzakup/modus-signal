// Training-stage-only capture. Native browser tab video, controlled through Browser MCP.
(function(){
  'use strict';
  if(location.origin!=='http://127.0.0.1:8791'||location.pathname!=='/stage')throw new Error('Training stage only');
  var stream,session=null,button;
  var api=window.tutorialCapture={state:'idle'};
  navigator.mediaDevices.setCaptureHandleConfig({exposeOrigin:true,handle:'modus-tutorial-8791',permittedOrigins:[location.origin]});
  api.connect=async function(){
    if(!['idle','error','ended'].includes(api.state)||(session&&!session.finished))throw new Error('Capture session already active');
    api.state='awaiting-selection';
    if(button)button.disabled=true;
    try{
      stream=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'browser',frameRate:25},audio:false,preferCurrentTab:true,selfBrowserSurface:'include',monitorTypeSurfaces:'exclude',surfaceSwitching:'exclude'});
      var track=stream.getVideoTracks()[0],handle=track.getCaptureHandle&&track.getCaptureHandle();
      if(track.getSettings().displaySurface!=='browser'||!handle||handle.handle!=='modus-tutorial-8791'||handle.origin!==location.origin){stream.getTracks().forEach(t=>t.stop());throw new Error('Выберите только вкладку учебной инструкции МОДУС');}
      if(typeof track.cropTo!=='function')throw new Error('Browser region capture unavailable');
      await track.cropTo(await CropTarget.fromElement(document.getElementById('stage')));
      track.addEventListener('ended',()=>{api.state='ended';if(session&&!session.finished&&session.recorder.state!=='inactive')session.recorder.stop();else if(button)button.disabled=false;});
      api.state='ready';
      return {ready:true,settings:track.getSettings()};
    }catch(e){if(stream)stream.getTracks().forEach(t=>t.stop());api.state='error';api.error=e.name+': '+e.message;if(button)button.disabled=false;return {error:api.error};}
  };
  api.start=function(id){
    if(api.state!=='ready'||!/^\d{2}(?:-[a-z0-9]+)?$/.test(id))throw new Error('Capture not ready or invalid scene');
    var current={scene:id,sequence:0,upload:Promise.resolve(),failure:null,finished:false,queuedBytes:0,started:performance.now()};
    session=current;
    var type=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm;codecs=vp8';
    var recorder=current.recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:3500000});
    var resolveCompletion;current.completion=new Promise(resolve=>{resolveCompletion=resolve;});
    var timer=setTimeout(()=>{if(recorder.state!=='inactive'){current.failure=new Error('Scene exceeded five minutes');recorder.stop();}},300000);
    recorder.onstop=async function(){
      clearTimeout(timer);await current.upload;current.finished=true;
      api.state=stream.getVideoTracks()[0].readyState==='live'?'ready':'ended';
      if(button)button.disabled=api.state!=='ended';
      resolveCompletion({ok:!current.failure,error:current.failure&&current.failure.message,scene:id,seconds:(performance.now()-current.started)/1000,chunks:current.sequence});
    };
    recorder.onerror=function(event){current.failure=new Error(event.error&&event.error.message||'Recorder failed');if(recorder.state!=='inactive')recorder.stop();};
    recorder.ondataavailable=function(event){
      if(!event.data.size)return;
      var part=current.sequence++;current.queuedBytes+=event.data.size;
      if(current.queuedBytes>24*1024*1024){current.failure=new Error('Upload backlog exceeded limit');if(recorder.state!=='inactive')recorder.stop();}
      current.upload=current.upload.then(async()=>{
        if(current.failure)return;
        var r=await fetch('/__tutorial/clip?scene='+id+'&part='+part,{method:'POST',headers:{'Content-Type':'video/webm'},body:event.data,signal:AbortSignal.timeout(15000)});
        if(!r.ok)throw new Error('Clip upload failed: '+r.status);
      }).catch(e=>{current.failure=e;if(recorder.state!=='inactive')recorder.stop();}).finally(()=>{current.queuedBytes-=event.data.size;});
    };
    recorder.start(1000);api.state='recording';api.scene=id;api.started=performance.now();
    return {recording:true,scene:id};
  };
  api.stop=function(){
    if(!session)throw new Error('No recording has started');
    if(session.recorder.state!=='inactive')session.recorder.stop();
    return session.completion;
  };
  button=document.createElement('button');button.textContent='Разрешить запись этой учебной вкладки';button.id='captureConnect';button.style.cssText='position:fixed;right:8px;bottom:4px;z-index:999;font:12px Arial';button.onclick=()=>api.connect();document.body.appendChild(button);
})();
