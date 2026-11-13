"""Create a recording manifest and measured offline narration from the writer JSON.
python prepare.py docs/tutorial/narration-draft.json artifacts/tutorial/manifest.json
The output points only to future real clips; no synthetic app video is generated.
"""
import argparse
import json
from pathlib import Path
import re

from render import digest, duration, synthesize, write_json


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('draft',type=Path)
    parser.add_argument('manifest',type=Path)
    parser.add_argument('--engine',choices=['sapi','edge'],default='sapi')
    parser.add_argument('--video-extension',choices=['webm','mp4'],default='webm')
    args=parser.parse_args()
    draft=json.loads(args.draft.read_text(encoding='utf-8-sig'))
    originals=draft.get('scenes')
    if not isinstance(originals,list) or not originals:
        raise ValueError('Draft must contain a nonempty scenes list')
    ids=[scene.get('sceneId') if isinstance(scene,dict) else None for scene in originals]
    if any(not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9_-]+',value) for value in ids):
        raise ValueError('Scene ids must be nonempty safe identifiers: letters, digits, underscores or hyphens')
    if len(set(value.casefold() for value in ids))!=len(ids):
        raise ValueError('Scene ids must be unique, including on case-insensitive filesystems')
    target=args.manifest.resolve()
    partial=target.with_name(target.stem+'.partial'+target.suffix)
    target.parent.mkdir(parents=True,exist_ok=True)
    audio=target.parent/'audio'
    audio.mkdir(exist_ok=True)
    scenes=[]
    manifest=dict(title=draft['title'],width=1280,height=720,fps=25,crf=22,
                  output='render',disclosure='УЧЕБНЫЕ ДАННЫЕ',
                  sourceDraftSha256=digest(args.draft),narrationEngine=args.engine,scenes=scenes)
    cursor=0.0
    for original in originals:
        scene=dict(id=original['sceneId'],title=original['title'],
                   video=f"clips/{original['sceneId']}.{args.video_extension}",text=original['narration'],
                   role=original['role'],rate=1,highlights=[],
                   recordingSteps=original['exactUiSteps'],callouts=original['onScreenCallouts'])
        if args.engine=='edge':
            from neural import synthesize_neural
            voice,captions=synthesize_neural(scene,audio)
        else:
            voice,captions=synthesize(scene,audio)
        scene.update(voice=voice.relative_to(target.parent).as_posix(),subtitles=captions,
                     narrationSeconds=round(duration(voice),3),
                     recordingSeconds=round(duration(voice)+2.0,3),startSeconds=round(cursor,3))
        cursor+=duration(voice)+.5
        scenes.append(scene)
        manifest['estimatedFinalSeconds']=round(cursor,3)
        write_json(partial,manifest)
        print(f"{scene['id']}: voice {scene['narrationSeconds']:.2f}s; record >= {scene['recordingSeconds']:.2f}s; {scene['title']}",flush=True)
    partial.replace(target)
    print(f'Total spoken timeline: {cursor:.2f}s. Manifest: {target}',flush=True)


if __name__=='__main__':
    main()
