Make an implementation of ScaffoldSketch that works in the browser. Use ([`@ygingold/webhands3d`](https://www.npmjs.com/package/@ygingold/webhands3d),
<https://github.com/yig/webhands3d/>) for hand-tracking with world-space coordinates. The paper describing ScaffoldSketch is `scaffoldsketch.tex`. An implementation is in `../code-new`; you can read that code, but you can't directly re-use it for licensing reasons. An earlier version of the code with a safe license is in `../code-old`.

Save and maintain a document describing the implementation's design and architecture. Commit changes as you work.

If changes are needed to `webhands3d`, we can make them. We also develop that library.

Right index fingertip draws. Draw when holding the shift key or when the left hand's five fingertips all come together. Switch from scaffold to shape drawing when the tab key is pressed or when the right hand's five fingertips all come together. Translate, rotate, and zoom when both hands are fists by tracking the motion of the fists.
