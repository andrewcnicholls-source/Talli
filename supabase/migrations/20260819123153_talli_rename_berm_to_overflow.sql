-- "Berm" is what it is; "overflow" is what it does. The second is what a
-- customer understands and what the marshal says out loud on the night.
update zone set
  label = 'Overflow — street verge',
  consent_prompt = 'Happy to go in the overflow area on the grass verge by the road '
                || 'if that gets you out fastest? It is council land, so on rare '
                || 'occasions a ticket is possible.'
where code = 'berm';

update zone set
  label = 'Overflow — 84 Paice verge',
  consent_prompt = 'Happy to go in the overflow area on the grass verge by the road?'
where code = 'neighbour_berm';

update bay set label = replace(label, 'Street berm', 'Overflow')
where label like 'Street berm%';
