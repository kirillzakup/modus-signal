"""Build the user-authorized Russian tutorial PDF from its Markdown source."""
import html
from pathlib import Path
import re

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'docs/tutorial/guide.md'
OUTPUT = ROOT / 'artifacts/tutorial/modus-signal-guide.pdf'
NAVY = colors.HexColor('#082742')
RED = colors.HexColor('#e00000')
PALE = colors.HexColor('#edf2f7')
pdfmetrics.registerFont(TTFont('Guide', 'C:/Windows/Fonts/arial.ttf'))
pdfmetrics.registerFont(TTFont('GuideBold', 'C:/Windows/Fonts/arialbd.ttf'))
pdfmetrics.registerFontFamily('Guide', normal='Guide', bold='GuideBold', italic='Guide', boldItalic='GuideBold')
styles = getSampleStyleSheet()
styles.add(ParagraphStyle('GuideBody', fontName='Guide', fontSize=10.3, leading=15,
                          textColor=NAVY, spaceAfter=7, alignment=TA_LEFT))
styles.add(ParagraphStyle('GuideTitle', parent=styles['GuideBody'], fontName='GuideBold',
                          fontSize=25, leading=31, spaceAfter=17))
styles.add(ParagraphStyle('GuideChapter', parent=styles['GuideBody'], fontName='GuideBold',
                          fontSize=15, leading=20, spaceBefore=18, spaceAfter=10, keepWithNext=True))
styles.add(ParagraphStyle('GuideSub', parent=styles['GuideBody'], fontName='GuideBold',
                          fontSize=12, leading=17, spaceBefore=9, keepWithNext=True))
styles.add(ParagraphStyle('GuideList', parent=styles['GuideBody'], leftIndent=13, firstLineIndent=-10))
styles.add(ParagraphStyle('GuideNote', parent=styles['GuideBody'], backColor=PALE,
                          borderPadding=9, spaceBefore=7, spaceAfter=13))
styles.add(ParagraphStyle('GuideCell', parent=styles['GuideBody'], fontSize=9.3, leading=13, spaceAfter=0))


def inline(text):
    # Arial covers Cyrillic and punctuation; omit decorative emoji glyphs.
    text = ''.join(c for c in text if ord(c) < 0x1F000 and c != '\ufe0f')
    text = html.escape(text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', lambda m: '<a href="' + m[2] + '" color="#1664a6">' + m[1] + '</a>', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'`([^`]+)`', r'\1', text)
    return text


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor('#d9e2ec'))
    canvas.line(18*mm, 17*mm, A4[0]-18*mm, 17*mm)
    canvas.setFont('Guide', 8)
    canvas.setFillColor(NAVY)
    canvas.drawString(18*mm, 11*mm, 'МОДУС · СИГНАЛ — руководство пользователя')
    canvas.drawRightString(A4[0]-18*mm, 11*mm, str(doc.page))
    canvas.restoreState()


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    width = A4[0]-36*mm
    story=[]
    logo=ROOT/'public/telegram-avatar.png'
    if logo.exists():
        brand=Table([[Image(str(logo),width=18*mm,height=18*mm),Paragraph('МОДУС · СИГНАЛ<br/><font size="10">От обращения к решению</font>',styles['GuideSub'])]],colWidths=[24*mm,width-24*mm])
        brand.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),0)]))
        story.extend([brand,Spacer(1,10*mm)])
    lines=SOURCE.read_text(encoding='utf-8').splitlines()
    i=0
    while i<len(lines):
        line=lines[i].strip()
        if not line or line=='---': i+=1;continue
        if line.startswith('|'):
            rows=[]
            while i<len(lines) and lines[i].strip().startswith('|'):
                cells=[v.strip() for v in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-{2,}:?',c) for c in cells):
                    rows.append([Paragraph(inline(c),styles['GuideCell']) for c in cells])
                i+=1
            table=Table(rows,colWidths=[width/len(rows[0])]*len(rows[0]),repeatRows=1,hAlign='LEFT')
            table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),PALE),('VALIGN',(0,0),(-1,-1),'TOP'),('GRID',(0,0),(-1,-1),.4,colors.HexColor('#d9e2ec')),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]))
            story.extend([table,Spacer(1,9)]);continue
        if line.startswith('# '): style='GuideTitle';line=line[2:]
        elif line.startswith('## '): style='GuideChapter';line=line[3:]
        elif line.startswith('### '): style='GuideSub';line=line[4:]
        elif line.startswith('> '): style='GuideNote';line=line[2:]
        elif re.match(r'^(?:\d+\.|[-*])\s',line):
            style='GuideList'
            if line[0] in '-*': line='• '+line[2:]
        else: style='GuideBody'
        story.append(Paragraph(inline(line),styles[style]));i+=1
    doc=SimpleDocTemplate(str(OUTPUT),pagesize=A4,rightMargin=18*mm,leftMargin=18*mm,topMargin=17*mm,bottomMargin=23*mm,title='МОДУС · СИГНАЛ: от регистрации до награды',author='МОДУС · СИГНАЛ')
    doc.build(story,onFirstPage=footer,onLaterPages=footer)
    print(str(OUTPUT))


if __name__=='__main__': main()
