import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BlockIcon } from './BlockIcon';

describe('BlockIcon', () => {
  it('draws an emoji as is and a known name as its emoji', () => {
    expect(render(<BlockIcon icon="🚀" size="lg" />).container.textContent).toBe('🚀');
    expect(render(<BlockIcon icon="police_car_light" size="md" />).container.textContent).toBe('🚨');
  });

  it('draws nothing for a name ex does not know, never ":name:"', () => {
    expect(render(<BlockIcon icon="rotating_light" size="lg" />).container).toBeEmptyDOMElement();
  });
});
