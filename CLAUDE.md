## Design Context

### Users
El proyecto se usa como cronómetro de presentación/sprint donde una persona organiza secciones con duraciones y controla avance en vivo desde un solo panel.

### Brand Personality
La personalidad buscada es precisa, directa y controlada, pensada para entornos de trabajo donde importa claridad y ritmo.

### Aesthetic Direction
Interfaz oscura, minimal y técnica, centrada en legibilidad y control temporal.

### Accessibility Requirements
Mantener contraste alto en estado normal y respetar `prefers-reduced-motion` para usuarios sensibles al movimiento.

### Performance Constraints
Single-file HTML/CSS/JS, sin librerías ni framework; deben priorizarse animaciones ligeras con `transform` y `opacity` para preservar fluidez en móvil.
