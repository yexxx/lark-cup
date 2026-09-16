import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateHtml} from '../server/html.js';
import {demoDesigns,demoHtml,demoSvg} from '../server/demo-art.js';
test('HTML with actual SVG is accepted, raster disguises and textual SVG strings are rejected',()=>{
 assert.throws(()=>validateHtml(Buffer.from('<!doctype html><html><body><img src="bird.png"></body></html>')),/SVG/);
 assert.throws(()=>validateHtml(Buffer.from('<!doctype html><html><body><script>const fake="<svg><path /></svg>";</script></body></html>')),/SVG/);
 assert.throws(()=>validateHtml(Buffer.from('<!doctype html><html><body><svg><path d="M0 0"/><image href="data:image/png;base64,AAAA"/></svg></body></html>')),/图片/);
 for(const design of demoDesigns){assert.doesNotThrow(()=>validateHtml(Buffer.from(demoHtml(design))));assert.ok(demoSvg(design,true).includes('animateTransform'));assert.ok(!demoHtml(design).includes('data:image'));}
});
