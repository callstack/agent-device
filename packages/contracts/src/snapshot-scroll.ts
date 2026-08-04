export function isScrollableType(type: string | null | undefined): boolean {
  const value = `${type ?? ''}`.toLowerCase();
  return (
    value.includes('scroll') ||
    value.includes('recyclerview') ||
    value.includes('listview') ||
    value.includes('gridview') ||
    value.includes('collectionview') ||
    value === 'table'
  );
}

export function isScrollableNodeLike(node: {
  type?: string | null;
  role?: string | null;
  subrole?: string | null;
}): boolean {
  if (isScrollableType(node.type)) {
    return true;
  }
  const role = `${node.role ?? ''} ${node.subrole ?? ''}`.toLowerCase();
  return role.includes('scroll');
}
