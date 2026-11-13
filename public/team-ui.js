(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.ModusTeamUI=factory();
})(typeof window!=='undefined'?window:this,function(){
  'use strict';
  var columns=[
    {key:'collect',label:'Предложения',hint:'Каждый предлагает, как решить проблему'},
    {key:'vote',label:'Голосование',hint:'Команда выбирает лучший вариант'},
    {key:'doing',label:'Выполнение',hint:'Выполняем выбранное решение'},
    {key:'check',label:'Проверка',hint:'Проверяем, что проблема устранена'},
    {key:'solved',label:'Решено',hint:'Проблема решена, вклад команды отмечен'}
  ];
  function column(t){
    if(t.board==='solved'||t.status==='closed')return 'solved';
    if(t.board==='check'||t.status==='done')return 'check';
    if(t.team&&['setup','collect'].indexOf(t.team.phase)>=0)return 'collect';
    if(t.team&&t.team.phase==='vote')return 'vote';
    return 'doing';
  }
  function create(env){
    var esc=env.esc,fmt=env.fmt;
    function deadline(t){return t.team&&(t.team.phase==='collect'?t.team.collectUntil:t.team.voteUntil);}
    function activeMember(t){return !!(t.team&&t.team.participants.some(function(p){return p.id===env.me().id;}));}
    function action(t){
      if(!t.team)return '';
      if(!activeMember(t)&&!t.team.canSchedule&&!t.team.canAdvance&&!t.team.canChoose)return '';
      if(t.team.phase==='setup')return t.team.canSchedule?'Задайте сроки обсуждения':'';
      if(t.team.phase==='collect'&&!t.team.myResponded)return 'Предложите решение';
      if(t.team.phase==='vote'&&!t.team.myVoted&&(!t.team.votingEnded||t.team.votedCount===0))return 'Проголосуйте';
      if(t.team.canChoose)return 'Выберите из лидеров голосования';
      if(t.team.canAdvance)return t.team.phase==='collect'?'Откройте голосование':'Подведите итог голосования';
      if(t.team.phase==='ready'&&t.canManage&&t.status==='review')return 'Начните выполнение';
      return '';
    }
    function progress(t){
      if(!t.team)return '';
      var g=t.team;
      if(g.phase==='setup')return 'Руководитель назначает сроки';
      if(g.phase==='collect')return 'Ответили '+g.respondedCount+' из '+g.total;
      if(g.phase==='vote')return 'Проголосовали '+g.votedCount+' из '+g.total;
      return 'Решение выбрано командой';
    }
    function panel(t){
      var g=t.team,k=column(t),current=columns.find(function(c){return c.key===k;});
      if(!g)return '';
      var step=columns.map(function(c,i){return '<span class="team-stage'+(c.key===k?' active':'')+'">'+(i+1)+'. '+c.label+'</span>';}).join('');
      var help=k==='collect'?'Сначала соберём предложения всей команды. Голосование начнётся после ответов всех участников или окончания срока.':
        k==='vote'?'Выберите один вариант. Голос можно изменить до подведения итога; повторные нажатия не приносят дополнительные монеты.':
        k==='doing'?'Выполняем выбранное командой решение. Ответственный фиксирует результат.':
        k==='check'?'Проверяем результат. Если проблема осталась — возвращаем на доработку.':'Спасибо команде за участие!';
      var button='';
      if(g.phase==='setup')help='Руководитель задаёт сроки предложений и голосования. После этого команда получит приглашение к обсуждению.';
      if(k==='collect'&&activeMember(t)&&!g.myResponded)button='<button class="btn red" data-act="teamFocus">Предложить решение · +5 монет</button>';
      if(k==='vote'&&activeMember(t)&&!g.myVoted&&(!g.votingEnded||g.votedCount===0))button='<button class="btn red" data-act="teamFocus">Выбрать вариант · +2 монеты</button>';
      if(g.canAdvance)button+='<button class="btn line" data-act="teamAdvance">'+(g.phase==='collect'?'Начать голосование':'Подвести итог')+'</button>';
      if(k==='doing'&&t.status==='review'&&t.canManage)button='<button class="btn red" data-act="cardNext" data-v="doing">Начать выполнение</button>';
      if(k==='doing'&&t.status==='work'&&t.canManage)button='<button class="btn red" data-act="cardNext" data-v="check">Записать результат</button>';
      if(k==='check'&&t.canConfirm)button='<button class="btn red" data-act="cardNext" data-v="solved">Проблема решена</button><button class="btn line" data-act="cardNext" data-v="doing">Вернуть на доработку</button>';
      if(g.phase==='setup')button='';
      if(g.canSchedule)button+='<button class="btn '+(g.phase==='setup'?'red':'line')+'" data-act="teamSchedule">'+(g.phase==='setup'?'Назначить сроки':'Изменить сроки')+'</button>';
      var due=(k==='collect'||k==='vote')&&deadline(t);
      return '<section class="card team-panel" aria-label="Командное решение"><div class="team-stages">'+step+'</div><div class="row between"><div><h2>'+esc(current.label)+'</h2><b>'+esc(action(t)||progress(t))+'</b></div>'+(due?'<span class="team-deadline">До '+fmt(due)+'</span>':'')+'</div><p class="muted">'+help+'</p>'+(button?'<div class="row" style="gap:8px">'+button+'</div>':'')+'</section>';
    }
    function options(t){
      var g=t.team,member=activeMember(t),collect=g.phase==='collect',voting=g.phase==='vote';
      if(g.phase==='setup')return '';
      var rows=(t.options||[]).map(function(o,i){
        var choice=o.chosen||!!(t.decision&&t.decision.optionId===o.id),buttons='';
        if(voting&&member&&(!g.votingEnded||g.votedCount===0))buttons='<button class="btn '+(o.voted?'navy':'line')+' sm" data-act="optVote" data-v="'+esc(o.id)+'">'+(o.voted?'✓ Ваш голос':'Голосовать')+'</button>';
        if(g.canChoose&&g.topIds.indexOf(o.id)>=0)buttons+='<button class="btn red sm" data-act="optChoose" data-v="'+esc(o.id)+'">Выбрать из лидеров</button>';
        return '<article class="team-option'+(choice?' chosen':'')+'"><div class="row between"><b>Вариант '+(i+1)+(choice?' · Победитель':'')+'</b><span class="small muted">'+esc(o.userName||'Коллега')+'</span></div><p>'+esc(o.text)+'</p>'+(o.effect?'<p class="small muted">Что изменится: '+esc(o.effect)+'</p>':'')+'<div class="row between"><span class="small">'+(collect?'Обсудим после сбора всех предложений':(o.votesCount||0)+' голосов')+'</span><div class="row" style="gap:6px">'+buttons+'</div></div></article>';
      }).join('');
      var form='';
      if(collect&&member&&!(t.options||[]).some(function(o){return o.userId===env.me().id;}))form='<div class="team-proposal"><label class="f" for="optText">Как вы предлагаете решить проблему?</label><textarea class="inp" id="optText" maxlength="1500" placeholder="Что конкретно сделать, чтобы проблема не повторялась?"></textarea><label class="f" for="optEff" style="margin-top:10px">Что улучшится? <span class="muted">Необязательно</span></label><input class="inp" id="optEff" maxlength="300" placeholder="Например: встречи будут начинаться вовремя"><div class="row" style="margin-top:12px;gap:8px"><button class="btn red" data-act="optAdd">Отправить предложение · +5 монет</button><button class="btn line" data-act="teamPass">Пока нет своего предложения</button></div><p class="help">Одно предложение и одно начисление на проблему. Если своего варианта нет, отметьте, что ознакомились — команда не будет ждать ваш ответ.</p></div>';
      if(collect&&g.myResponded&&!form)form='<div class="team-confirmed">✓ Ваш ответ учтён. Можно прочитать предложения коллег. Голосование откроется следующим этапом.</div>';
      var people=g.participants.map(function(p){var done=collect?p.responded:p.voted;return '<span class="team-person'+(done?' answered':'')+'">'+(done?'✓ ':'○ ')+esc(p.name)+'</span>';}).join('');
      var tie=g.canChoose?'<div class="team-confirmed">Несколько вариантов набрали одинаковое число голосов. Ответственный выбирает один из лидеров и объясняет выбор.</div>':'';
      return '<section class="card" id="teamOptions" style="margin-top:16px"><div class="row between"><h2>'+(collect?'Предложения команды':voting?'Выбираем решение':'Решение команды')+'</h2><span class="tag">'+esc(progress(t))+'</span></div>'+tie+(rows||'<p class="muted">Предложений пока нет. Начните обсуждение своим вариантом.</p>')+form+(g.phase!=='ready'?'<details class="team-participants"><summary>Участники · '+g.total+'</summary><div class="team-people">'+people+'</div></details>':'')+'</section>';
    }
    function coins(){return '<section class="card" style="margin-top:18px"><h2>За что начисляются монеты</h2><p class="muted">Участвуйте в решении общих проблем. Заработанные монеты можно обменять на награды.</p><div class="team-coin-rules">'+[[5,'Предложили решение'],[2,'Проголосовали'],[15,'Ваш вариант победил'],[10,'Довели работу до результата']].map(function(r){return '<div><b>+'+r[0]+' 🪙</b><span>'+r[1]+'</span></div>';}).join('')+'</div><p class="help">За предложение и голос — один бонус на человека в каждой проблеме. За повторные нажатия монеты не начисляются.</p><a class="btn navy" href="#/shop">В магазин наград</a></section>';}
    function tasks(list){
      var relevant=list.filter(function(t){return action(t);});
      return '<section class="card" style="margin-top:16px"><h2>Команда ждёт вашего участия · '+relevant.length+'</h2>'+(relevant.length?relevant.map(function(t){return '<a class="team-task" href="#/t/'+esc(t.id)+'"><div><b>'+esc(t.title)+'</b><div class="small muted">'+esc(progress(t))+'</div></div><span class="btn red sm">'+esc(action(t))+'</span></a>';}).join(''):'<p class="muted">Сейчас все ваши ответы учтены. Новые обсуждения появятся на доске и в уведомлениях.</p>')+'</section>';
    }
    return {panel:panel,options:options,progress:progress,action:action,coins:coins,tasks:tasks,deadline:deadline};
  }
  return {columns:columns,column:column,create:create};
});
